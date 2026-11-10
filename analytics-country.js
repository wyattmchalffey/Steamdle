const { isIP, BlockList } = require('node:net');
const path = require('node:path');

const COUNTRIES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY ' +
    'HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY ' +
    'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

function normalizeCountry(value) {
    return typeof value === 'string' && COUNTRIES.has(value.toUpperCase()) ? value.toUpperCase() : '';
}

const excluded = new BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) excluded.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
    ['::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) excluded.addSubnet(address, prefix, 'ipv6');
// Cross-zone Cloudflare Worker requests use a shared synthetic connecting IP.
excluded.addAddress('2a06:98c0::103', 'ipv6');

function publicAddress(value) {
    if (typeof value !== 'string' || value.length > 45 || value.includes('%')) return '';
    const version = isIP(value);
    return version && !excluded.check(value, version === 4 ? 'ipv4' : 'ipv6') ? value : '';
}

async function loadCountryDatabase(env) {
    // The library's default import initializes synchronously. Disable that one-time
    // behavior so downloading/updating country ranges never delays game startup.
    const previous = process.env.ILA_SKIP_INITIAL_RELOAD;
    process.env.ILA_SKIP_INITIAL_RELOAD = 'true';
    let geo;
    try { geo = require('ip-location-api'); }
    finally {
        if (previous === undefined) delete process.env.ILA_SKIP_INITIAL_RELOAD;
        else process.env.ILA_SKIP_INITIAL_RELOAD = previous;
    }
    const directory = path.resolve(env.RENDER_DISK_MOUNT_PATH || '/data', 'analytics-country');
    await geo.reload({
        fields: 'country', addCountryInfo: false, smallMemory: false,
        ipLocationDb: 'user', autoUpdate: '0 0 3 * * wed,sat', silent: true,
        dataDir: path.join(directory, 'data'), tmpDataDir: path.join(directory, 'downloads'),
        skipInitialReload: true
    });
    return geo;
}

function createCountryLookup(load = loadCountryDatabase, now = Date.now) {
    let lookup;
    let pending;
    let retryAt = 0;
    let status = 'not_started';
    return {
        start(env) {
            if (pending) return pending;
            if (lookup || now() < retryAt) return Promise.resolve();
            status = 'loading';
            retryAt = now() + 5 * 60000;
            pending = Promise.resolve().then(() => load(env)).then(geo => {
                lookup = geo.lookup;
                status = 'ready';
            }).catch(() => {
                // Do not log the request or address when geography is unavailable.
                status = 'unavailable';
            }).finally(() => { pending = null; });
            return pending;
        },
        lookup(address) {
            try { return normalizeCountry(lookup?.(address)?.country); }
            catch { return ''; }
        },
        status() { return status; }
    };
}

const database = createCountryLookup();
if (process.env.RENDER === 'true') void database.start(process.env);

function lookupCountry(address, env) {
    void database.start(env);
    return database.lookup(address);
}

function requestCountry(req, env = process.env, lookup = lookupCountry) {
    // Render sends public web-service traffic through Cloudflare. Only trust its
    // overwritten connecting-IP header in that deployment; X-Forwarded-For can
    // contain client-supplied prefixes. No raw address leaves this module.
    // https://render.com/articles/how-render-handles-ddos-attacks
    // https://developers.cloudflare.com/fundamentals/reference/http-headers/
    if (env.RENDER !== 'true' || !/^[a-f0-9]{16,32}-[A-Z]{3}$/i.test(req.get('CF-Ray') || '')) return '';
    const address = publicAddress(req.get('CF-Connecting-IP'));
    if (!address) return '';
    try { return normalizeCountry(lookup(address, env)); }
    catch { return ''; }
}

module.exports = { requestCountry, normalizeCountry, createCountryLookup, countryLookupStatus: database.status };
