import json
import os
from pathlib import Path
import textwrap
import unittest
from unittest.mock import patch


class RestoreFixtureSelectionTests(unittest.TestCase):
    def test_fixture_selection_and_aggregate(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/ci.yml').read_text()
        fixtures = workflow.split('  restore-fixtures:\n', 1)[1].split('  ci-ok:\n', 1)[0]
        self.assertIn("if: github.event_name != 'pull_request' || "
                      "needs.changes.outputs.full_run == 'true' || "
                      "fromJSON(needs.changes.outputs.areas).backup", fixtures)
        script = workflow.split("          python3 -I - <<'PY'\n", 1)[1].split('\n          PY', 1)[0]
        code = compile(textwrap.dedent(script), 'ci-ok', 'exec')
        for event, full_run, backup, selected in (
            ('push', False, False, True),
            ('schedule', False, False, True),
            ('workflow_dispatch', False, False, True),
            ('pull_request', False, False, False),
            ('pull_request', True, False, True),
            ('pull_request', False, True, True),
        ):
            for result in ('success', 'skipped', 'failure'):
                with self.subTest(event=event, full_run=full_run, backup=backup, result=result):
                    jobs = {
                        'changes': {'result': 'success', 'outputs': {
                            'full_run': str(full_run).lower(),
                            'areas': json.dumps({'backup': backup}),
                        }},
                        'unit': {'result': 'success'},
                        'security': {'result': 'success'},
                        'restore-fixtures': {'result': result},
                    }
                    with patch.dict(os.environ, {'NEEDS': json.dumps(jobs), 'EVENT_NAME': event}):
                        if result == 'failure' or (selected and result == 'skipped'):
                            with self.assertRaises(AssertionError):
                                exec(code, {})
                        else:
                            exec(code, {})
