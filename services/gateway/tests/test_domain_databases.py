# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import annotations

import pytest
pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

import unittest
from unittest.mock import AsyncMock, patch
from sciencediscovery_gateway import public_biomed_mcp as m

PATCH = "sciencediscovery_gateway.public_biomed_mcp."

class DomainDatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_alphafold_keeps_versions_prediction_type_and_provider_file(self):
        item = {"entryId": "AF-P69905-F1", "uniprotAccession": "P69905", "latestVersion": 6,
                "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.cif", "globalMetricValue": 98.06}
        with patch(PATCH + "_get_json", new=AsyncMock(return_value=[item])):
            result = await m.alphafold_prepare_prediction_download("P69905")
            missing = await m.alphafold_prepare_prediction_download("P69905", "pae")
        record = result["records"][0]
        self.assertEqual(record["identifier"], "AF-P69905-F1")
        self.assertEqual(record["primaryCitation"]["sourceVersion"], "6")
        self.assertEqual(record["structuredData"]["structureType"], "predicted")
        self.assertEqual(record["crossReferences"][0]["identifier"], "P69905")
        self.assertEqual(result["artifacts"][0]["logicalName"], "AF-P69905-F1-model_v6.cif")
        self.assertEqual(missing["artifacts"], [])
        self.assertIn("not available", missing["warnings"][0])
        item["cifUrl"] = "https://evil.example/model.cif"
        with patch(PATCH + "_get_json", new=AsyncMock(return_value=[item])):
            with self.assertRaisesRegex(ValueError, "allowlist"):
                await m.alphafold_prepare_prediction_download("P69905")

    async def test_alphafold_invalid_missing_and_ambiguous_models(self):
        with self.assertRaises(ValueError):
            await m.alphafold_lookup_prediction("../P69905")
        with patch(PATCH + "_get_json", new=AsyncMock(return_value=[])):
            result = await m.alphafold_lookup_prediction("P69905")
            self.assertEqual(result["records"], [])
            self.assertTrue(result["warnings"])
            with self.assertRaisesRegex(ValueError, "model_id"):
                await m.alphafold_prepare_prediction_download("P69905", model_id="missing")

    async def test_geo_lists_real_multi_platform_and_supplementary_files_and_rejects_forged_names(self):
        async def listing(url, **kwargs):
            if "/matrix/" in url:
                return '<a href="GSE1000-GPL1_series_matrix.txt.gz">one</a><a href="GSE1000-GPL2_series_matrix.txt.gz">two</a><a href="https://evil.example/x">evil</a><a href="../suppl/">parent</a>'
            if "/soft/" in url:
                raise RuntimeError("HTTP 404 Not Found from ftp.ncbi.nlm.nih.gov")
            return '<a href="counts.tsv.gz">counts</a>'
        with patch(PATCH + "_get_text", new=AsyncMock(side_effect=listing)):
            result = await m.geo_list_files("GSE1000", limit=2)
            self.assertEqual(len(result["data"]["files"]), 2)
            self.assertEqual(result["data"]["pagination"]["nextOffset"], 2)
            last = await m.geo_list_files("GSE1000", offset=2)
            self.assertEqual(last["data"]["files"][0]["file_name"], "counts.tsv.gz")
            with self.assertRaisesRegex(ValueError, "file_name"):
                await m.geo_prepare_dataset_download("GSE1000")
            with self.assertRaises(ValueError):
                await m.geo_prepare_dataset_download("GSE1000", file_name="../../private")
            selected = await m.geo_prepare_dataset_download("GSE1000", "supplementary", "counts.tsv.gz")
            self.assertTrue(selected["artifacts"][0]["sourceUrl"].endswith('/suppl/counts.tsv.gz'))
            self.assertEqual(selected["artifacts"][0]["sourceRecordId"], "GSE1000")
        self.assertIn('/GSEnnn/GSE1/', m._geo_paths('GSE1')[1])

    async def test_geo_miniml_request_retains_accession_and_sample_annotations(self):
        xml = '<MINiML xmlns="http://www.ncbi.nlm.nih.gov/geo/info/MINiML"><Sample iid="GSM1"><Title>treated</Title><Channel><Organism>Homo sapiens</Organism><Characteristics tag="treatment">dexamethasone</Characteristics></Channel><Platform-Ref ref="GPL1"/></Sample><Sample iid="GSM2"><Title>control</Title></Sample></MINiML>'
        getter = AsyncMock(return_value=xml)
        with patch(PATCH + "_get_text", new=getter):
            result = await m.geo_get_samples("GSE1000", limit=1)
        self.assertEqual(getter.await_args_list[0].kwargs["params"]["acc"], "GSE1000")
        self.assertEqual(getter.await_args_list[1].kwargs["params"]["acc"], "GSM1")
        self.assertEqual(getter.await_args_list[1].kwargs["params"]["view"], "quick")
        data = result["records"][0]["structuredData"]["metadata"]
        self.assertEqual(data["Channel"][0]["Characteristics"][0]["text"], "dexamethasone")
        self.assertEqual(data["Platform-Ref"][0]["attributes"]["ref"], "GPL1")
        self.assertEqual(result["data"]["pagination"]["nextOffset"], 1)
        with patch(PATCH + "_get_text", new=AsyncMock(return_value='<html>not found</html>')):
            with self.assertRaisesRegex(ValueError, "MINiML"):
                await m.geo_lookup_accession("GSM1")

    async def test_geo_network_failure_is_not_reported_as_empty_directory(self):
        with patch(PATCH + "_get_text", new=AsyncMock(side_effect=RuntimeError("HTTP 503 Service Unavailable"))):
            with self.assertRaisesRegex(RuntimeError, "503"):
                await m.geo_list_files("GSE1000")

    async def test_chembl_preserves_units_assays_and_scanned_page_when_confidence_filters_rows(self):
        activities = [{"activity_id": 1, "assay_chembl_id": "CHEMBL1", "standard_value": "10", "standard_units": "nM", "standard_relation": "="},
                      {"activity_id": 2, "assay_chembl_id": "CHEMBL2", "standard_value": "20", "standard_units": "nM", "standard_relation": "="}]
        getter = AsyncMock(side_effect=[{"activities": activities, "page_meta": {"total_count": 10}},
            {"assays": [{"assay_chembl_id": "CHEMBL1", "confidence_score": 8}, {"assay_chembl_id": "CHEMBL2", "confidence_score": 9}]}])
        with patch(PATCH + "_get_json", new=getter):
            result = await m.chembl_search_activities(target_chembl_id="CHEMBL203", standard_type="IC50", standard_units="nM", standard_relation="=", standard_value_max=100, confidence_score_min=9, offset=2, limit=2)
        params = getter.await_args_list[0].kwargs["params"]
        self.assertEqual(params["standard_value__lte"], 100)
        self.assertEqual(params["offset"], 2)
        self.assertNotIn("assay_chembl_id__confidence_score__gte", params)
        self.assertEqual(len(result["records"]), 1)
        self.assertEqual(result["records"][0]["identifier"], "2")
        self.assertTrue(result["records"][0]["url"].endswith('/activity/2.json'))
        self.assertEqual(result["records"][0]["structuredData"]["standard_units"], "nM")
        page = result["data"]["pagination"]
        self.assertEqual((page["scanned"], page["returned"], page["nextOffset"]), (2, 1, 4))
        self.assertTrue(result["warnings"])

    async def test_chembl_rejects_incomplete_measurement_constraints_and_missing_assay_metadata(self):
        with self.assertRaises(ValueError):
            await m.chembl_search_activities()
        with self.assertRaisesRegex(ValueError, "ceiling"):
            await m.chembl_search_activities(target_chembl_id="CHEMBL203", standard_value_max=100)
        with self.assertRaises(ValueError):
            await m.chembl_search_activities(target_chembl_id="../x")
        with patch(PATCH + "_get_json", new=AsyncMock(side_effect=[{"activities": [{"activity_id": 1, "assay_chembl_id": "CHEMBL1"}]}, {"assays": []}])):
            with self.assertRaisesRegex(ValueError, "metadata"):
                await m.chembl_search_activities(target_chembl_id="CHEMBL203", confidence_score_min=9)

    async def test_clinvar_retains_separate_conflicting_submissions_and_version(self):
        xml = '<ClinVarResult-Set><VariationArchive Accession="VCV000014206" Version="2" VariationID="14206" VariationName="variant"><ClassifiedRecord><SimpleAllele><Location><SequenceLocation Assembly="GRCh38" start="100"/></Location></SimpleAllele><ClinicalAssertionList><ClinicalAssertion><ClinVarAccession Accession="SCV000000001" Version="1" SubmitterName="Lab A"/><Classification DateLastEvaluated="2026-01-01"><ReviewStatus>criteria provided</ReviewStatus><GermlineClassification>Pathogenic</GermlineClassification></Classification></ClinicalAssertion><ClinicalAssertion><ClinVarAccession Accession="SCV000000002" Version="3" SubmitterName="Lab B"/><Classification><ReviewStatus>criteria provided</ReviewStatus><GermlineClassification>Benign</GermlineClassification></Classification></ClinicalAssertion></ClinicalAssertionList></ClassifiedRecord></VariationArchive></ClinVarResult-Set>'
        getter = AsyncMock(return_value=xml)
        with patch(PATCH + "_get_text", new=getter):
            result = await m.clinvar_get_assertions('VCV000014206.2')
        self.assertEqual(getter.await_args.kwargs['params']['id'], 'VCV000014206.2')
        record = result['records'][0]
        self.assertEqual(record['primaryCitation']['sourceVersion'], '2')
        self.assertEqual(record['structuredData']['assemblies'][0]['Assembly'], 'GRCh38')
        submissions = record['structuredData']['assertions']
        self.assertEqual([s['accession'] for s in submissions], ['SCV000000001', 'SCV000000002'])
        self.assertIn('Pathogenic', str(submissions[0]))
        self.assertIn('Benign', str(submissions[1]))

    async def test_clinvar_rcv_numeric_missing_and_oversized_records(self):
        xml = '<ClinVarResult-Set><ClinVarSet><ReferenceClinVarAssertion><ClinVarAccession Acc="RCV000000606" Version="4"/></ReferenceClinVarAssertion><ClinVarAssertion><ClinVarAccession Acc="SCV000000001" Version="1"/></ClinVarAssertion></ClinVarSet></ClinVarResult-Set>'
        getter = AsyncMock(return_value=xml)
        with patch(PATCH + '_get_text', new=getter):
            result = await m.clinvar_get_assertions('RCV000000606')
        self.assertEqual(getter.await_args.kwargs['params']['rettype'], 'clinvarset')
        self.assertEqual(result['records'][0]['structuredData']['assertions'][0]['accession'], 'SCV000000001')
        with patch(PATCH + '_get_text', new=AsyncMock(return_value='<ClinVarResult-Set/>')):
            missing = await m.clinvar_get_assertions('123')
            self.assertEqual(missing['records'], [])
            self.assertTrue(missing['warnings'])
        with patch(PATCH + '_get_text', new=AsyncMock(return_value='x' * 1_500_001)):
            with self.assertRaisesRegex(ValueError, 'size'):
                await m.clinvar_get_assertions('123')
        with self.assertRaises(ValueError):
            await m.clinvar_get_assertions('not-an-accession')

    async def test_pdb_download_retains_experimental_evidence_and_version(self):
        entry = {'struct': {'title': 'CRAMBIN'}, 'rcsb_accession_info': {'revision_date': '2026-01-01'}, 'exptl': [{'method': 'X-RAY DIFFRACTION'}]}
        with patch(PATCH + '_pdb_entry', new=AsyncMock(return_value=entry)):
            result = await m.pdb_prepare_structure_download('1CRN')
        record = result['records'][0]
        self.assertEqual(record['structuredData']['structureType'], 'experimental')
        self.assertEqual(record['primaryCitation']['sourceVersion'], '2026-01-01')
        self.assertEqual(result['artifacts'][0]['sourceRecordId'], '1CRN')

if __name__ == '__main__':
    unittest.main()
