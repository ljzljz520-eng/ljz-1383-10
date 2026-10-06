'use strict';
const express = require('express');
const { serializeFilmSummary, serializeFilmDetail } = require('../serializers');

module.exports = function publicRoutes(ctx) {
  const { db, vis } = ctx;
  const r = express.Router();
  const regionOf = (req) => (req.query.region || 'GLOBAL').toUpperCase();

  // 公开搜索：与详情使用同一序列化器，保证结果一致
  r.get('/films', (req, res) => {
    const region = regionOf(req);
    const q = (req.query.query || '').trim();
    let films;
    if (q) {
      const like = `%${q}%`;
      films = db.all(
        `SELECT * FROM films WHERE title LIKE ? OR original_title LIKE ? OR director_name LIKE ? ORDER BY year DESC, id DESC`,
        [like, like, like]
      );
    } else {
      films = db.all('SELECT * FROM films ORDER BY year DESC, id DESC');
    }
    res.json({ region, count: films.length, films: films.map((f) => serializeFilmSummary(db, vis, f, region)) });
  });

  r.get('/films/:id', (req, res) => {
    const region = regionOf(req);
    const film = db.get('SELECT * FROM films WHERE id=?', [Number(req.params.id)]);
    if (!film) return res.status(404).json({ error: 'film_not_found' });
    res.json(serializeFilmDetail(db, vis, film, region));
  });

  // 放映记录：按版本分组，体现"绑定实际版本"
  r.get('/films/:id/screenings', (req, res) => {
    const film = db.get('SELECT * FROM films WHERE id=?', [Number(req.params.id)]);
    if (!film) return res.status(404).json({ error: 'film_not_found' });
    const rows = db.all(
      `SELECT s.id, s.festival_name, s.venue, s.city, s.country, s.screened_at, s.notes,
              v.id AS version_id, v.label AS version_label, v.subtitle_revision
       FROM screenings s JOIN versions v ON v.id = s.version_id
       WHERE v.film_id=? AND v.status='published'
       ORDER BY s.screened_at DESC, s.id DESC`,
      [film.id]
    );
    res.json({ film_id: film.id, title: film.title, screenings: rows });
  });

  return r;
};
