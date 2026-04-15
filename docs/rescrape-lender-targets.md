# Re-scrape lender keyword targets

Use this to re-scrape only companies that already have lender keywords found,
applying any fixes made to the PDF extraction logic.

## Steps

**1. Generate the filtered input CSV**
```powershell
node scripts/make-lender-input.mjs
```
This reads `output/finance_table_data.jsonl` and writes `input/lender_targets.csv`
with only companies where lender keywords were found.

**2. Re-scrape those companies**
```powershell
$env:RESCAN_LENDER=1; npm run scrape -- --input input/lender_targets.csv
```
`RESCAN_LENDER=1` forces the scraper to re-process companies it has already scraped.

**3. Rebuild the CSV**
```powershell
npm run process
```

**4. Re-import into the CRM**
```powershell
cd crm; npm run import-csv -- ../output/financial_data_atomic.csv
```
