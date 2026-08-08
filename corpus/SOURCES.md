# Medicare enrollment corpus — source index

Fetched **2026-08-08** via `curl -L -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"`. HTML converted with cheerio (navigation/footer/cards removed; wording unaltered). PDFs converted with `npx pdf-parse text` (page markers and CMS footers removed; wording unaltered).

| File | Source URL | Fetch date | Word count | Anchor check |
| --- | --- | --- | ---: | --- |
| [01-when-coverage-starts.md](docs/01-when-coverage-starts.md) | https://www.medicare.gov/basics/get-started-with-medicare/sign-up/when-does-medicare-coverage-start | 2026-08-08 | 1481 | **PASS** — all 6 anchors present |
| [02-avoid-penalties.md](docs/02-avoid-penalties.md) | https://www.medicare.gov/basics/costs/medicare-costs/avoid-penalties | 2026-08-08 | 820 | **PASS** — all 7 anchors present |
| [03-working-past-65.md](docs/03-working-past-65.md) | https://www.medicare.gov/basics/get-started-with-medicare/medicare-basics/working-past-65 | 2026-08-08 | 1382 | **PARTIAL** — see flags below |
| [04-special-enrollment-periods.md](docs/04-special-enrollment-periods.md) | https://www.medicare.gov/basics/get-started-with-medicare/get-more-coverage/joining-a-plan/special-enrollment-periods | 2026-08-08 | 3472 | **PASS** — all 5 anchors present |
| [05-ma-drug-plan-enrollment-periods.md](docs/05-ma-drug-plan-enrollment-periods.md) | https://www.medicare.gov/publications/11219-Understanding-Medicare-Advantage-Medicare-Drug-Plan-Enrollment-Periods.pdf | 2026-08-08 | 3992 | **PASS** — all anchors present (see note on `28th month`) |
| [06-part-d-late-enrollment-penalty.md](docs/06-part-d-late-enrollment-penalty.md) | https://www.medicare.gov/publications/11222-part-d-late-enrollment-penalty.pdf | 2026-08-08 | 1477 | **PASS** — all 8 anchors present |
| [07-2026-medicare-costs.md](docs/07-2026-medicare-costs.md) | https://www.medicare.gov/publications/11579-medicare-costs.pdf | 2026-08-08 | 771 | **PASS** — all 9 anchors present |
| [08-cfr-407-25-entitlement.md](docs/08-cfr-407-25-entitlement.md) | https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-407/subpart-B/section-407.25 | 2026-08-08 | 502 | **PASS** — pre-2023 table (incl. July 1 row) and post-2023 rule present |

## Skipped

| File | Reason |
| --- | --- |
| `09-when-to-sign-up.md` | Source page does not state the born-on-the-1st-of-the-month IEP rule verbatim (rule appears on [when-does-medicare-coverage-start](https://www.medicare.gov/basics/get-started-with-medicare/sign-up/when-does-medicare-coverage-start) in a help drawer: coverage starts the month before you turn 65 if birthday is on the 1st). |

## Cross-doc consistency (2026-08-08)

| Value | Docs | Result |
| --- | --- | --- |
| `$202.90` (2026 Part B standard premium) | 02, 07 | **Agree** |
| `$38.99` (2026 national base beneficiary premium) | 02, 06, 07 | **Agree** |
| 7-month IEP | 01, 05 | **Agree** (wording varies; both describe 3 months before / month of / 3 months after) |
| GEP Jan 1–Mar 31 | 01, 04, 05, 08 | **Agree** (hyphen/en-dash variants only) |

## Flags for human review

### 03-working-past-65.md

- **20-employee threshold:** Not stated on this page. Closest medicare.gov wording is on the interactive sign-up wizard (`when-can-i-sign-up-for-medicare`): *"Because the company has less than 20 employees, your job-based coverage might not pay for health services if you don't have both Part A and Part B."*
- **COBRA/retiree ≠ employment-based coverage:** Not stated verbatim on this page. Stated on `01-when-coverage-starts.md` SEP table: *"COBRA isn't considered group health plan coverage."* This page lists *"Your COBRA coverage or retiree coverage ends"* under situations that **don't** qualify for a Part B SEP.

### 05-ma-drug-plan-enrollment-periods.md

- **Disability IEP `28th month`:** Present but split across PDF text lines (`28th` / `month` on adjacent lines) — verified in source PDF.

## Hygiene

All eight files: UTF-8 without BOM, LF line endings, single trailing newline, no trailing whitespace on any line. Junk scan: no matches for `Skip to`, `cookie`, or navigation boilerplate.
