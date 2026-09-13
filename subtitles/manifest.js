const pkg = require('../package.json');

module.exports = {
    id: 'community.ncore.hungarian.subtitles',
    version: pkg.version,
    name: 'Magyar feliratok (nCore)',
    description: 'Feliratok feltöltése IMDB ID alapján – megjelennek Stremioban.',
    logo: 'https://ncore-catalog-addon-production.up.railway.app/logo.png',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};
