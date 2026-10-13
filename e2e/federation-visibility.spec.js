import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Mount the actual connection panel with a local API fixture. These tests never
// change a real connection or transmit an agent's data to a federation peer.
export async function visibilityFixtureModule() {
    const app = await readFile('web/static/js/app.js', 'utf8');
    const start = app.indexOf('function fedCatalogMap(');
    const end = app.indexOf('\nfunction FederationWarmup(', start);
    return `
import * as directory from '/ui/js/federation-directory.js';
import { federationPeerAgentCompatibility } from '/ui/js/federation-peer-capabilities.js';
const { FederationDirectory, stageFederationDomains } = directory;
const html = window.html = htm.bind(preact.h);
const { useState, useEffect, useRef } = preactHooks;
const icons = {};
const showToast = () => {};
const showConfirmation = async () => true;
const id = letter => letter.repeat(64);
const agent = (letter, name, provider = 'codex') => ({ agent_id: id(letter), name, registered_name: provider + '/' + name.toLowerCase(), provider, status: 'active' });
const agents = [agent('a', 'Sage'), agent('b', 'Research'), agent('c', 'Quiettype', 'claude-code')];
const requestedCount = Math.min(80, Number(new URLSearchParams(location.search).get('count') || 3));
for (let number = 4; number <= requestedCount; number++) agents.push({ ...agent('d', 'Helper ' + number, number % 2 ? 'codex' : 'claude-code'), agent_id: number.toString(16).padStart(2, '0') + '0'.repeat(62) });
agents[2].messaging_blocked = true;
window.fixtureRoster = agents;
// A registry row can be active locally without an eligible consensus enrollment.
const stale = agent('e', 'Retired enrollment');
const initialMode = new URLSearchParams(location.search).get('mode') || 'none';
let exposure = { mode: initialMode, agent_ids: initialMode === 'selected' ? [id('a')] : [], revision: 7, configured: true };
window.exposureRequests = [];
window.rejectSave = false;
window.visibilityRefreshes = 0;
const fedAgentExposureGet = async () => { window.visibilityRefreshes++; return { exposure, agents }; };
const fedAgentExposureSet = async (chain, body) => {
    window.exposureRequests.push({ chain, ...body });
    if (window.rejectSave || body.agent_ids.includes(stale.agent_id)) {
        const error = new Error('Agent discovery changed. Refresh this connection and review it before saving.');
        error.status = 409;
        throw error;
    }
    if (body.expected_revision !== exposure.revision) throw new Error('Stale revision');
    exposure = { ...body, revision: exposure.revision + 1, configured: true };
    return { exposure };
};
const fetchAgents = async () => ({ agents: [...agents, stale] });
const fedShareableDomains = async () => ({ domains: [{ domain: 'research', can_share: true }] });
const fedPermissionsGet = async () => ({ local_permissions: [], remote_permissions: [], remote_known: true });
const fedSyncGet = async () => ({ subscribe_domains: [] });
const fedSyncStatus = async () => ({});
const fedAgentExportsGet = async () => ({ exports: [] });
const fedReaderRestrictionsGet = async () => ({ restrictions: [] });
const contacts = agents.map(item => ({ ...item, display_name: item.name, available: true, accepting: true, address: item.agent_id + '@home' }));
const fedPipeContactsGet = async () => ({ local_node_contacts: { contacts: exposure.mode === 'none' ? [] : contacts.filter(item => exposure.mode === 'all' || exposure.agent_ids.includes(item.agent_id)).slice(0, 20) }, local_contacts: { contacts: [] }, remote_known: true, remote_contacts: { contacts: [{ ...contacts[0], display_name: 'Amy helper', address: id('d') + '@amy' }] } });
${app.slice(start, end)}
preact.render(html\`<\${FedPermissionsPanel}
    conn=\${{ remote_chain_id: 'amy-chain', peer_name: 'Aimee MAir', local_role: new URLSearchParams(location.search).get('role') || 'host' }}
    localName="L33TDAWG-SAGE" connectionStatus=\${{ capabilities: ['federated-node-messaging-v1'] }}
    onRevoke=\${() => {}} />\`, document.getElementById('fixture'));
`;
}

async function openVisibility(page, mode = 'none', extraQuery = '') {
    const module = await visibilityFixtureModule();
    await page.route('http://federation-visibility.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui/css/sage.css"></head><body><main class="fed-page" style="max-width:1100px;margin:24px auto;padding:16px" id="fixture"></main><script src="/ui/js/vendor/preact.umd.js"></script><script src="/ui/js/vendor/preact.hooks.umd.js"></script><script src="/ui/js/vendor/htm.umd.js"></script><script type="module" src="/fixture.js"></script></body></html>` });
        if (pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: module });
        const relative = pathname.replace(/^\/ui\//, '');
        if (!/^(js\/vendor\/(preact\.umd|preact\.hooks\.umd|htm\.umd)\.js|js\/federation-(directory|peer-capabilities)\.js|css\/sage\.css)$/.test(relative)) return route.abort();
        return route.fulfill({ contentType: relative.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(path.resolve('web/static', relative)) });
    });
    await page.goto('http://federation-visibility.test/?mode=' + mode + extraQuery);
    await expect(page.getByRole('heading', { name: 'Agents across this connection' })).toBeVisible();
}

for (const role of ['host', 'guest']) test(`individual visibility saves the exact chosen agent as ${role}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await openVisibility(page, 'none', '&role=' + role);
    const sage = page.locator('.fed-directory-agent').filter({ hasText: 'codex/sage' });
    await sage.getByRole('switch').check();
    expect(await page.evaluate(() => window.exposureRequests)).toEqual([]);
    await page.getByRole('button', { name: 'Save visibility' }).click();
    await expect.poll(() => page.evaluate(() => window.exposureRequests)).toEqual([{ chain: 'amy-chain', mode: 'selected', agent_ids: ['a'.repeat(64)], expected_revision: 7 }]);
    await expect(sage.getByRole('switch')).toBeChecked();
    expect(errors).toEqual([]);
});

test('narrowing all agents uses the eligible roster rather than stale registry rows', async ({ page }) => {
    await openVisibility(page, 'all');
    await page.locator('.fed-directory-agent').filter({ hasText: 'codex/sage' }).getByRole('switch').uncheck();
    await expect(page.getByText('Retired enrollment', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save visibility' }).click();
    await expect.poll(() => page.evaluate(() => window.exposureRequests)).toEqual([{ chain: 'amy-chain', mode: 'selected', agent_ids: ['b'.repeat(64), 'c'.repeat(64)], expected_revision: 7 }]);
    await expect(page.getByRole('alert')).toHaveCount(0);
});

test('search, provider and visibility filters scope bulk changes; selecting all stays explicit', async ({ page }) => {
    await openVisibility(page);
    const provider = page.getByRole('combobox', { name: 'Filter by provider' });
    await provider.selectOption('codex');
    await expect(page.locator('.fed-directory-agent')).toHaveCount(2);
    await page.getByRole('button', { name: 'Show matching' }).click();
    await page.getByRole('button', { name: 'Save visibility' }).click();
    await expect.poll(() => page.evaluate(() => window.exposureRequests[0])).toEqual({ chain: 'amy-chain', mode: 'selected', agent_ids: ['a'.repeat(64), 'b'.repeat(64)], expected_revision: 7 });
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByRole('button', { name: /^Hidden/ }).click();
    await expect(page.locator('.fed-directory-agent')).toHaveCount(1);
    await page.getByRole('button', { name: 'Show matching' }).click();
    await page.getByRole('button', { name: 'Save visibility' }).click();
    await expect.poll(() => page.evaluate(() => window.exposureRequests[1])).toEqual({ chain: 'amy-chain', mode: 'selected', agent_ids: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)], expected_revision: 8 });
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByRole('searchbox', { name: 'Find an agent' }).fill('claude quiet');
    await expect(page.locator('.fed-directory-agent')).toHaveCount(1);
    await page.getByRole('button', { name: 'Hide matching' }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save visibility' })).toBeDisabled();
});

test('save conflicts preserve the draft and expose refresh beside the choices', async ({ page }) => {
    await openVisibility(page, 'selected');
    await page.evaluate(() => { window.rejectSave = true; });
    await page.getByRole('switch', { name: 'Make Research visible to Aimee MAir' }).check();
    await page.getByRole('button', { name: 'Save visibility' }).click();
    await expect(page.getByRole('alert')).toContainText('Refresh this connection');
    await expect(page.getByRole('switch', { name: 'Make Research visible to Aimee MAir' })).toBeChecked();
    await page.getByRole('button', { name: 'Refresh visibility' }).click();
    await expect.poll(() => page.evaluate(() => window.visibilityRefreshes)).toBe(2);
    await expect(page.getByRole('switch', { name: 'Make Research visible to Aimee MAir' })).not.toBeChecked();
    await expect(page.getByRole('alert')).toHaveCount(0);
});

test('remote contacts stay read-only and layouts fit mobile and increased text size', async ({ page }) => {
    await openVisibility(page, 'selected');
    await expect(page.locator('.fed-directory').getByText('Not accepting', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: /visible to L33TDAWG/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Agents on Aimee MAir' }).click();
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.locator('.fed-directory').getByRole('button', { name: /Copy address for Amy helper/ })).toBeVisible();
    await page.getByRole('button', { name: /^Your agents/ }).click();
    await page.locator('.fed-directory').screenshot({ path: test.info().outputPath('visibility-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /^Hidden/ }).click();
    await page.getByRole('switch', { name: 'Make Research visible to Aimee MAir' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('switch', { name: 'Make Research visible to Aimee MAir' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Make Research visible to Aimee MAir' })).toBeFocused();
    await expect(page.locator('.fed-directory-agent')).toHaveCount(2);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('visibility-mobile.png'), fullPage: true });
    await page.evaluate(() => {
        const elements = [...document.querySelectorAll('.fed-directory, .fed-directory *')];
        const sizes = elements.map(element => parseFloat(getComputedStyle(element).fontSize));
        elements.forEach((element, index) => { element.style.fontSize = sizes[index] * 2 + 'px'; });
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('searching the full roster preserves agents beyond the bounded contact page', async ({ page }) => {
    await openVisibility(page, 'all', '&count=80');
    await page.getByRole('searchbox', { name: 'Find an agent' }).fill('Helper 72');
    await expect(page.locator('.fed-directory-agent')).toHaveCount(1);
    await page.getByRole('button', { name: 'Hide matching' }).click();
    await page.getByRole('button', { name: 'Save visibility' }).click();
    await expect.poll(() => page.evaluate(() => window.exposureRequests.length)).toBe(1);
    const expected = await page.evaluate(() => window.fixtureRoster.filter(agent => agent.name !== 'Helper 72').map(agent => agent.agent_id).sort());
    expect(await page.evaluate(() => window.exposureRequests[0].agent_ids)).toEqual(expected);
    await expect(page.getByRole('switch')).not.toBeChecked();
});
