# Checkov fixtures

Captured real output from Checkov, used by `tests/checkov_report_test.ts`.

- Image: `bridgecrew/checkov:3.3.29`
- Digest:
  `sha256:3cc125b5337717b7303dbddd4e79374c120687b5ff6a24f9abdad56b562469f3`
- Command: `checkov -d . --framework cloudformation -o json --skip-download`
- Captured: 2026-10-20

Each case directory holds `report.json` (Checkov's stdout, verbatim and
untrimmed) and, where a skip needs to be looked up, the `template.yaml` Checkov
scanned. `no_templates` has no template, as the case is a scan that finds
nothing to check.

| Case            | Observed exit code | What it shows                                               |
| --------------- | ------------------ | ----------------------------------------------------------- |
| clean           | 0                  | Two checks passed, nothing failed                           |
| failed          | 1                  | `CKV_AWS_158` failed                                        |
| reasoned_skip   | 0                  | Skip with an inline reason                                  |
| reasonless_skip | 0                  | Skip with no reason (Checkov reports "No comment provided") |
| metadata_skip   | 0                  | Skip set only under `Metadata`                              |
| parse_error     | 0                  | Template could not be parsed; Checkov still exits 0         |
| no_templates    | 0                  | No CloudFormation templates; summary-only object            |
