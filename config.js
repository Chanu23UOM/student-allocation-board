/**
 * Edit these two values after you deploy the Apps Script web app.
 * Leave API_URL empty to run the board in demo mode with sample data.
 */
window.APP_CONFIG = {
  // Paste the /exec URL from Apps Script > Deploy > New deployment
  API_URL: 'https://script.google.com/macros/s/AKfycbxbmmX9QwrZ2vpmCVhQzGaf5N16xT_BzwZh65XY5zixkH5bcFuybMmQjc8k-PRNdKf7/exec',

  // Must match CONFIG.API_TOKEN in apps-script/Code.gs
  API_TOKEN: 'abcdefghijklmnop',

  // How often to check the Sheet for changes, in milliseconds
  POLL_MS: 6000,

  // How long to wait after your last edit before saving, in milliseconds
  AUTOSAVE_MS: 1500
};
