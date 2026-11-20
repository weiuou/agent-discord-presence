// Test fixtures must not import packages installed in the developer's real npm home.
process.env.ADP_NPM_AUTOLOAD = '0';
