'use strict';
const axios = require('axios');
const { Settings, IpSecurity } = require('../db');

/**
 * Push current block list to a file in a GitHub repository (Contents API).
 * Requires classic PAT with repo scope, or fine-grained token with Contents read/write.
 */
async function syncBannedIpsToGitHub() {
    const token = Settings.get('github_sync_token', '')?.trim();
    const repo = Settings.get('github_sync_repo', '')?.trim(); // owner/name
    const path = Settings.get('github_sync_path', 'security/banned-ips.txt')?.trim();
    const branch = Settings.get('github_sync_branch', 'main')?.trim() || 'main';

    if (!token || !repo) {
        throw new Error('GitHub sync: set github_sync_token and github_sync_repo in Security Center');
    }

    const lines = IpSecurity.listBlockedIpsLines();
    const body = [
        '# ApiX Gateway — blocked IP addresses (CIDR)',
        `# Auto-synced: ${new Date().toISOString()}`,
        '# One entry per line. Lines starting with # are comments.',
        '',
        ...lines,
        '',
    ].join('\n');

    const content = Buffer.from(body, 'utf8').toString('base64');
    const [owner, name] = repo.split('/').map((s) => s.trim());
    if (!owner || !name) throw new Error('github_sync_repo must be owner/repo');

    const api = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`;
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };

    let sha = null;
    try {
        const cur = await axios.get(api, { headers, params: { ref: branch }, timeout: 15000 });
        sha = cur.data?.sha || null;
    } catch (e) {
        if (e.response?.status !== 404) throw e;
    }

    const payload = {
        message: `chore(security): sync banned IPs (${lines.length} entries)`,
        content,
        branch,
    };
    if (sha) payload.sha = sha;

    const put = await axios.put(api, payload, { headers, timeout: 20000 });
    return {
        updated: true,
        path: put.data?.content?.path || path,
        commit: put.data?.commit?.sha,
        lines: lines.length,
    };
}

module.exports = { syncBannedIpsToGitHub };
