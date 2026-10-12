# Walmart price management

Fetch confirmed Walmart prices into a SKU sheet, filter them, edit proposed prices, and submit those prices back to Walmart.

The hub serves this module at [http://localhost:3847/walmart-prices/](http://localhost:3847/walmart-prices/). Listing upload and maintenance flows are unchanged.

## Walmart API

Credentials stay on the server (`WALMART_CLIENT_ID`, `WALMART_CLIENT_SECRET` in the hub `.env`).

| Action | API |
| --- | --- |
| Fetch (default) | `POST /v3/reports/reportRequests?reportType=ITEM&reportVersion=v1`, poll `GET /v3/reports/reportRequests`, download the READY file, parse every CSV row |
| Fetch fallback | `GET /v3/items?limit=&nextCursor=` until the cursor is exhausted. The first request sends `nextCursor=*` |
| Verify one SKU | `GET /v3/items/{sku}` |
| Update | `PUT /v3/price` with `currentPriceType: BASE`, one SKU at a time, 250ms apart, retrying 429 and 5xx |

A local proposed price is not treated as live. `PUT /v3/price` success sets status **Unverified** and leaves the confirmed price unchanged. Status becomes **Success** only when a later read shows the same amount. A failed PUT sets **Failed** and does not change the confirmed price.

`WALMART_PRICE_FETCH_MODE=auto` tries the ITEM report, then the items API if the report is unavailable. `report` and `items` force one path. Auth failures are not retried as a fallback.

An interrupted report stores `data/jobs/fetch-checkpoint.json` and the next fetch resumes that request id.

## Sheet

`data/sheets/walmart-price-sheet.json` is the price sheet. It is gitignored. SKUs are stored exactly as Walmart returned them. A second row is not created when the same SKU arrives with different casing.

## Filters

Prefix and suffix checks are **case-insensitive**, same as the hub IS- series match.

| Filter | Match |
| --- | --- |
| All | Every SKU |
| MR- | Starts with `MR-` |
| IS- | Starts with `IS-` |
| Exclude MR- and IS- | Does not start with either prefix |
| All MR | SKU is an MR- product |
| MR-01FA | SKU ends with `-01FA` |
| MR-04HE | SKU ends with `-04HE` |

Prefix and MR category are combined. Search matches a full or partial SKU, also case-insensitive. The table is paged on the server.

## Updates

- **Update selected** — checked SKUs only, including checks from other pages
- **Update matching filter** — every eligible product in the current filter
- **Update all eligible** — every eligible product in the sheet

Eligible means the proposed price is valid and different from the confirmed Walmart price. The confirmation dialog shows the confirmed price and the proposed price. Bulk calls require `confirm: true`.

Set `WALMART_PRICE_ADMIN_TOKEN` to require header `x-price-admin-token` on fetch and update. The hub has no login of its own.

## Commands

```bash
npm install
npm test
```

Then start the hub from `marketplacesheet_use_template` as usual (`npm run hub`). Do not start a second hub if one is already running.
