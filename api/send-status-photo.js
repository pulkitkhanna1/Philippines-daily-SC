const chromium = require('@sparticuz/chromium');
const { chromium: playwrightChromium } = require('playwright-core');

const DEFAULT_SELECTOR = 'main.page';
const DEFAULT_WAIT_FOR = '#report-content .section-title, #status-bar';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    authorizeRequest(req);

    const body = getBody(req);
    const channelId = body.channelId || process.env.SLACK_DEFAULT_CHANNEL_ID;
    const threadTs = body.threadTs;
    const initialComment = body.message || 'Current bottom funnel status';
    const selector = body.selector || DEFAULT_SELECTOR;
    const pageUrl = resolvePageUrl(req, body);

    if (!channelId) {
      return res.status(400).json({
        ok: false,
        error: 'missing_channel_id',
        message: 'Pass channelId in the request body or set SLACK_DEFAULT_CHANNEL_ID.'
      });
    }

    if (!process.env.SLACK_BOT_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: 'missing_slack_token',
        message: 'SLACK_BOT_TOKEN is not configured.'
      });
    }

    const screenshot = await captureStatusScreenshot({
      pageUrl,
      selector,
      waitForSelector: body.waitForSelector || DEFAULT_WAIT_FOR
    });

    const fileName = buildFileName();
    const slackFile = await uploadToSlack({
      buffer: screenshot,
      fileName,
      channelId,
      threadTs,
      initialComment
    });

    return res.status(200).json({
      ok: true,
      pageUrl,
      fileName,
      file: slackFile
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: error.code || 'send_status_photo_failed',
      message: error.message
    });
  }
};

function authorizeRequest(req) {
  const expected = process.env.STATUS_PHOTO_API_KEY;
  if (!expected) return;

  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const supplied = req.headers['x-api-key'] || bearer;

  if (supplied !== expected) {
    const error = new Error('Unauthorized request.');
    error.statusCode = 401;
    error.code = 'unauthorized';
    throw error;
  }
}

function getBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function resolvePageUrl(req, body) {
  if (process.env.STATUS_PAGE_URL) return process.env.STATUS_PAGE_URL;

  const baseUrl = getBaseUrl(req);
  const requestedPath = typeof body.pagePath === 'string' && body.pagePath.trim() ? body.pagePath.trim() : '/';
  return new URL(requestedPath, baseUrl).toString();
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) {
    const error = new Error('Could not determine the deployment host. Set STATUS_PAGE_URL.');
    error.statusCode = 500;
    error.code = 'missing_host';
    throw error;
  }
  return `${proto}://${host}`;
}

async function captureStatusScreenshot({ pageUrl, selector, waitForSelector }) {
  let browser;

  try {
    browser = await playwrightChromium.launch({
      args: chromium.args,
      defaultViewport: { width: 1800, height: 2200, deviceScaleFactor: 1 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector(waitForSelector, { timeout: 20000 });

    await page.waitForFunction(() => {
      const report = document.querySelector('#report-content');
      const status = document.querySelector('#status-bar');
      return Boolean(report && report.children.length) || /failed/i.test(status?.textContent || '');
    }, { timeout: 20000 });

    const target = await page.$(selector);
    if (!target) {
      const error = new Error(`Could not find screenshot selector: ${selector}`);
      error.statusCode = 400;
      error.code = 'missing_selector';
      throw error;
    }

    return await target.screenshot({ type: 'png' });
  } finally {
    if (browser) await browser.close();
  }
}

async function uploadToSlack({ buffer, fileName, channelId, threadTs, initialComment }) {
  const uploadTicket = await slackApi('files.getUploadURLExternal', {
    filename: fileName,
    length: buffer.length,
    alt_txt: 'Current bottom funnel dashboard status'
  });

  const uploadResponse = await fetch(uploadTicket.upload_url, {
    method: 'POST',
    headers: {
      'Content-Length': String(buffer.length),
      'Content-Type': 'image/png'
    },
    body: buffer
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    const error = new Error(`Slack upload URL rejected the file: ${uploadResponse.status} ${text}`);
    error.code = 'slack_binary_upload_failed';
    error.statusCode = 502;
    throw error;
  }

  const completionPayload = {
    files: [{ id: uploadTicket.file_id, title: fileName }],
    channel_id: channelId,
    initial_comment: initialComment
  };

  if (threadTs) completionPayload.thread_ts = threadTs;

  const completed = await slackApi('files.completeUploadExternal', completionPayload);
  return completed.files?.[0] || { id: uploadTicket.file_id, title: fileName };
}

async function slackApi(method, payload) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Slack API ${method} returned HTTP ${response.status}: ${text}`);
    error.code = 'slack_http_error';
    error.statusCode = 502;
    throw error;
  }

  const data = await response.json();
  if (!data.ok) {
    const error = new Error(`Slack API ${method} failed: ${data.error || 'unknown_error'}`);
    error.code = data.error || 'slack_api_error';
    error.statusCode = 502;
    throw error;
  }

  return data;
}

function buildFileName() {
  const now = new Date();
  const iso = now.toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
  return `bottom-funnel-status-${iso}.png`;
}
