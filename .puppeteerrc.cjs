/**
 * Configure Puppeteer to skip downloading browser binaries during install.
 * This prevents install failures on slow networks, corporate proxies, and Windows.
 */
module.exports = {
  skipDownload: true,
};
