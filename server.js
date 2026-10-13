import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountWalmartPriceRoutes } from './src/index.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.WALMART_PRICE_PORT || 3850);
const app = express();

app.use(express.json({ limit: '30mb' }));
app.use('/hub-ui.css', express.static(path.resolve(root, '../marketplacesheet_use_template/hub/public/hub-ui.css')));
app.use('/walmart-prices', express.static(path.join(root, 'public')));
app.get('/', (_req, res) => {
  res.redirect('/walmart-prices/');
});
mountWalmartPriceRoutes(app);

app.listen(port, () => {
  console.log(`Walmart prices → http://localhost:${port}/walmart-prices/`);
});
