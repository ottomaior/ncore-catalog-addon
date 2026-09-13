const pkg = require('../package.json');

module.exports = {
    id: 'community.ncore.hungarian.trailers',
    version: pkg.version,
    name: '🎬 Magyar Előzetesek',
    description: 'Magyar szinkronos/feliratos előzetesek angol tartalékkal.',
    logo: 'https://ncore-catalog-addon-production.up.railway.app/logo.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'tmdb:'],
    catalogs: []
};
