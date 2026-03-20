'use strict';
/**
 * Semver + GitHub release tag handling (incl. pre-releases like v0.0.1-rc1).
 */
const semver = require('semver');

/**
 * Parse a Git tag or version string to a normalized semver string, or null.
 * Supports v0.0.1-rc1, v1.2.3-beta.1, etc.
 */
function versionFromTag(tag) {
    if (tag == null || tag === '') return null;
    let s = String(tag).trim().replace(/^v/i, '');
    // Strict semver often wants rc.1; accept rc1 as alias
    const rcShort = s.match(/^(\d+\.\d+\.\d+)-rc(\d+)$/i);
    if (rcShort) {
        s = `${rcShort[1]}-rc.${rcShort[2]}`;
    }
    const v = semver.valid(s);
    if (v) return semver.clean(v);
    return null;
}

/** Normalize version from package.json (must be semver-like). */
function normalizePackageVersion(raw) {
    const s = String(raw || '').trim();
    const v = semver.valid(s);
    if (v) return semver.clean(v);
    const c = semver.coerce(s);
    return c ? c.version : s;
}

/**
 * Pick the newest non-draft release. When stableOnly=false (default), pre-releases
 * participate so v0.0.3-rc1 can rank above v0.0.2 stable.
 */
function pickNewestRelease(releases, stableOnly) {
    const list = (releases || []).filter((r) => !r.draft);
    const filtered = stableOnly ? list.filter((r) => !r.prerelease) : list;
    const rows = filtered.map((r) => ({
        release: r,
        ver: versionFromTag(r.tag_name),
    }));
    const semRows = rows.filter((x) => x.ver);
    if (semRows.length) {
        semRows.sort((a, b) => semver.rcompare(a.ver, b.ver));
        return semRows[0].release;
    }
    const byDate = [...filtered].sort(
        (a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0),
    );
    return byDate[0] || null;
}

/**
 * Compare local (running) version to remote release version.
 * @param {string} remoteRaw — semver string from versionFromTag(tag_name)
 */
function compareVersions(localRaw, remoteRaw) {
    const lvn = normalizePackageVersion(localRaw);
    const lv = semver.valid(lvn) ? semver.clean(lvn) : versionFromTag(lvn);
    const rv = remoteRaw ? semver.clean(remoteRaw) : null;
    if (!lv || !rv) {
        return {
            comparable: false,
            update_available: false,
            local_ahead: false,
            equal: false,
        };
    }
    return {
        comparable: true,
        update_available: semver.gt(rv, lv),
        local_ahead: semver.gt(lv, rv),
        equal: semver.eq(lv, rv),
        local_clean: lv,
        remote_clean: rv,
    };
}

module.exports = {
    versionFromTag,
    normalizePackageVersion,
    pickNewestRelease,
    compareVersions,
};
