import assert from 'node:assert/strict';
import test from 'node:test';
import { filterFederationAgents, stageFederationDomains, updateFederationVisibility, federationVisibilityEqual } from '../web/static/js/federation-directory.js';

test('directory search works without memory grants and preserves exact identity', () => {
    const agents = [{ agent_id: 'first', display_name: 'codex/sage', provider: 'codex', domains: [] },
        { agent_id: 'second', registered_name: 'tii-helper', provider: 'claude-code', domains: [] }];
    assert.deepEqual(filterFederationAgents(agents, ' SAGE '), [agents[0]]);
    assert.deepEqual(filterFederationAgents(agents, 'claude'), [agents[1]]);
    assert.deepEqual(filterFederationAgents(agents, 'second'), [agents[1]]);
    assert.deepEqual(filterFederationAgents(agents, ''), agents);
});

test('visibility changes preserve exact identities outside the search and never opt future agents in', () => {
    const agents = [{ agent_id: 'first', name: 'Sage', provider: 'codex' }, { agent_id: 'second', name: 'Research', provider: 'claude-code' }];
    const all = { mode: 'all', agent_ids: [] };
    const narrowed = updateFederationVisibility(all, agents, ['first'], false);
    assert.deepEqual(narrowed, { mode: 'selected', agent_ids: ['second'] });
    assert.deepEqual(all, { mode: 'all', agent_ids: [] });
    assert.deepEqual(updateFederationVisibility(narrowed, agents, ['first', 'forged'], true), { mode: 'selected', agent_ids: ['first', 'second'] });
    assert.deepEqual(filterFederationAgents(agents, 'claude research', { visibility: 'visible', policy: narrowed }), [agents[1]]);
    assert.deepEqual(filterFederationAgents(agents, '', { provider: 'codex', visibility: 'hidden', policy: narrowed }), [agents[0]]);
    assert.equal(federationVisibilityEqual({ mode: 'selected', agent_ids: ['second', 'first'] }, { mode: 'selected', agent_ids: ['first', 'second'] }), true);
    assert.equal(federationVisibilityEqual(all, { mode: 'selected', agent_ids: ['first', 'second'] }), false);
});

test('bulk and drag/drop sharing only stage authorized domains and preserve prior draft choices', () => {
    const draft = { existing: { read: false, copy: true, write: false } };
    const catalog = { existing: { can_share: true }, research: { can_share: true }, private: { can_share: false } };
    const staged = stageFederationDomains(draft, catalog, ['research', 'existing', 'private', 'injected'], 'read');
    assert.deepEqual(draft, { existing: { read: false, copy: true, write: false } }, 'staging must not mutate saved state');
    assert.deepEqual(staged, { existing: { read: true, copy: true, write: false }, research: { read: true, copy: false, write: false } });
    assert.equal(stageFederationDomains(draft, catalog, ['research'], 'write'), draft);
    assert.equal(stageFederationDomains(null, catalog, ['research'], 'read'), null);
});
