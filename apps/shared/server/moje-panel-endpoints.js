// Endpointy panelu „Moje" (widok handlowca na własną umowę) — montowane w
// apps/moje/server/server.js za bramką auth (panel NIE jest adminOnly: Lorenzo
// z uprawnieniem `moje` widzi TYLKO swoje). Ten sam silnik co /test
// (test-panel-metrics.js -> buildKokpit), inny ubiór na froncie: mniej audytu,
// więcej „zrób to teraz". Zero endpointów zapisujących i zero AI-scoringu —
// panel Lorenza jest wyłącznie do odczytu (materiał na odsłuch / oceny AI
// zostają narzędziem Antoniego w /test).
const { buildKokpit } = require('./test-panel-endpoints');

function registerMojePanelEndpoints(app, { getClient }) {
  app.get('/api/moje/kokpit', async (req, res) => {
    try {
      res.json(await buildKokpit(getClient()));
    } catch (err) {
      console.error('Kokpit /moje:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerMojePanelEndpoints };
