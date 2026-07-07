require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');

const app = express();
app.use(cors());
app.use(express.json());

function handleError(res, err, fallbackStatus = 400) {
  console.error(err);
  const message = err.message || 'Wewnętrzny błąd serwera';
  const status = /brak/i.test(message) ? 500 : fallbackStatus;
  res.status(status).json({ error: message });
}

app.get('/api/tables/:table', async (req, res) => {
  try {
    const supabase = getClient();
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const { data, error } = await supabase
      .from(req.params.table)
      .select('*')
      .limit(limit);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.post('/api/tables/:table', async (req, res) => {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from(req.params.table)
      .insert(req.body)
      .select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.put('/api/tables/:table/:id', async (req, res) => {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from(req.params.table)
      .update(req.body)
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Wiersz nie istnieje' });
    res.json(data[0]);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.delete('/api/tables/:table/:id', async (req, res) => {
  try {
    const supabase = getClient();
    const { error, count } = await supabase
      .from(req.params.table)
      .delete({ count: 'exact' })
      .eq('id', req.params.id);
    if (error) throw error;
    if (!count) return res.status(404).json({ error: 'Wiersz nie istnieje' });
    res.status(204).end();
  } catch (err) {
    handleError(res, err, 502);
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Serwer działa na http://localhost:${port}`);
});
