// Federation membership and memory grants are separate product controls.
export function federationAgentVisible(policy, agentID) {
    return !!policy && (policy.mode === 'all' || (policy.mode === 'selected' && (policy.agent_ids || []).includes(agentID)));
}

export function filterFederationAgents(agents, query, { provider = '', visibility = 'all', policy } = {}) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (agents || []).filter(agent => {
        const text = [agent.name, agent.display_name, agent.registered_name, agent.provider, agent.agent_id]
            .map(value => String(value || '').toLowerCase()).join(' ');
        return terms.every(term => text.includes(term)) && (!provider || (agent.provider || 'Agent') === provider) &&
            (visibility === 'all' || federationAgentVisible(policy, agent.agent_id) === (visibility === 'visible'));
    });
}

// Individual and filtered changes produce an exact selection. Only the explicit
// "Show all agents" action opts future enrollments into this connection.
export function updateFederationVisibility(policy, agents, agentIDs, visible) {
    const eligible = new Set(agents.map(agent => agent.agent_id));
    const selected = new Set(agents.filter(agent => federationAgentVisible(policy, agent.agent_id)).map(agent => agent.agent_id));
    for (const id of agentIDs) {
        if (!eligible.has(id)) continue;
        if (visible) selected.add(id); else selected.delete(id);
    }
    return { mode: selected.size ? 'selected' : 'none', agent_ids: [...selected].sort() };
}

export function federationVisibilityEqual(left, right) {
    return !!left && !!right && left.mode === right.mode &&
        JSON.stringify([...(left.agent_ids || [])].sort()) === JSON.stringify([...(right.agent_ids || [])].sort());
}

export function stageFederationDomains(draft, catalog, domains, permission) {
    if (!draft || !['read', 'copy', 'remove'].includes(permission)) return draft;
    const next = { ...draft };
    for (const domain of domains) {
        if (!Object.hasOwn(catalog, domain) || catalog[domain].can_share === false) continue;
        next[domain] = permission === 'remove' ? { read: false, write: false, copy: false } : { ...(next[domain] || { read: false, write: false, copy: false }), [permission]: true };
    }
    return next;
}

export function FederationDirectory({ peerName, localName, local, remote, automatic, copyAddress, loadMore, catalog, stageDomains, draft, disabled, visibility, showSharing = true }) {
    const html = window.html;
    const { useState, useEffect } = preactHooks;
    const [query, setQuery] = useState('');
    const [side, setSide] = useState('local');
    const [provider, setProvider] = useState('');
    const [visibilityFilter, setVisibilityFilter] = useState('all');
    const [visibilityDraft, setVisibilityDraft] = useState(null);
    const [domainQuery, setDomainQuery] = useState('');
    const [selected, setSelected] = useState([]);
    const [notice, setNotice] = useState('');
    const [loading, setLoading] = useState('');
    const [pages, setPages] = useState({});
    const [copied, setCopied] = useState('');
    const [domainLimit, setDomainLimit] = useState(24);
    const savedVisibility = visibility && visibility.policy;
    useEffect(() => { setVisibilityDraft(null); }, [savedVisibility]);
    const policy = visibilityDraft || savedVisibility;
    const roster = visibility && Array.isArray(visibility.agents) ? visibility.agents : [];
    const visibilityReady = !!savedVisibility && visibility && Array.isArray(visibility.agents);
    const visibilityDisabled = !visibilityReady || visibility.saving;
    const visibilityDirty = visibilityReady && !federationVisibilityEqual(policy, savedVisibility);
    const changeVisibility = (agentIDs, visible) => {
        if (visibilityDisabled) return;
        setVisibilityDraft(current => updateFederationVisibility(current || savedVisibility, roster, agentIDs, visible));
    };
    const changeAll = visible => {
        if (!visibilityDisabled) setVisibilityDraft({ mode: visible ? 'all' : 'none', agent_ids: [] });
    };
    const chooseSide = next => { if (next === side) return; setSide(next); setQuery(''); setProvider(''); setVisibilityFilter('all'); };
    const domains = Object.keys(catalog || {}).filter(domain => catalog[domain].can_share !== false && domain.toLowerCase().includes(domainQuery.toLowerCase()));
    const stage = (items, permission) => {
        if (disabled || !items.length) return;
        stageDomains(items, permission);
        setNotice(`${items.length} domains staged for ${permission === 'remove' ? 'removal from memory sharing' : permission === 'read' ? 'Read' : 'Copy'}. Review the permissions below and save to apply. Messaging remains governed by node trust.`);
        setSelected([]);
    };
    const localCursor = pages.local && pages.local.cursor;
    const remoteCursor = pages.remote && pages.remote.cursor;
    // Only explicitly browsed continuation pages add probes. Keep one current
    // page per side, revalidated independently of the parent's first-page poll.
    useEffect(() => {
        let live = true;
        let timer;
        const refresh = async () => {
            await Promise.all([['local', localCursor], ['remote', remoteCursor]].filter(([, cursor]) => cursor).map(async ([side, cursor]) => {
                try {
                    const grant = await loadMore(side, cursor);
                    if (live) setPages(current => current[side] && current[side].cursor === cursor ? { ...current, [side]: { cursor, grant } } : current);
                } catch {
                    if (live) setPages(current => current[side] && current[side].cursor === cursor ? { ...current, [side]: { cursor, grant: null, error: true } } : current);
                }
            }));
            if (live) timer = setTimeout(refresh, 8000);
        };
        if (localCursor || remoteCursor) timer = setTimeout(refresh, 8000);
        return () => { live = false; clearTimeout(timer); };
    }, [localCursor, remoteCursor, peerName]);
    const more = async (side, cursor) => {
        setLoading(side);
        try {
            const grant = await loadMore(side, cursor);
            setPages(current => ({ ...current, [side]: { cursor, grant } }));
        }
        catch (error) { setNotice(error.message || 'Could not load more agents. Try again.'); }
        finally { setLoading(''); }
    };
    const copy = async (agent, nodeName) => {
        try {
            if (await copyAddress(agent) === false) throw new Error('Could not copy the address.');
            setCopied(agent.address);
            setNotice(`Message address copied for ${agent.display_name || agent.registered_name || 'agent'} on ${nodeName}.`);
        } catch { setNotice('Could not copy the agent address. Try again.'); }
    };
    const operatorRoster = side === 'local' && !!visibility;
    const activePage = pages[side];
    const grant = activePage ? activePage.grant : (side === 'local' ? local : remote);
    const contacts = grant && Array.isArray(grant.contacts) ? grant.contacts : [];
    const allAgents = (operatorRoster ? roster : contacts).slice().sort((a, b) =>
        String(a.display_name || a.name || a.registered_name || a.agent_id).localeCompare(String(b.display_name || b.name || b.registered_name || b.agent_id)));
    // Keep rows and keyboard focus stable while editing a filtered selection.
    // Visibility filters reflect the saved policy until Save confirms the draft.
    const agents = filterFederationAgents(allAgents, query, { provider, visibility: operatorRoster ? visibilityFilter : 'all', policy: savedVisibility });
    const providers = [...new Set(allAgents.map(agent => agent.provider || 'Agent'))].sort();
    const visibleCount = roster.filter(agent => federationAgentVisible(policy, agent.agent_id)).length;
    const savedVisibleCount = roster.filter(agent => federationAgentVisible(savedVisibility, agent.agent_id)).length;
    const changedCount = roster.filter(agent => federationAgentVisible(policy, agent.agent_id) !== federationAgentVisible(savedVisibility, agent.agent_id)).length;
    const filtersActive = !!query.trim() || !!provider || visibilityFilter !== 'all';
    const clearFilters = () => { setQuery(''); setProvider(''); setVisibilityFilter('all'); };
    const matchingVisible = agents.filter(agent => federationAgentVisible(policy, agent.agent_id)).length;
    return html`<section class="fed-directory" aria-label="Federation agent directory">
        <div class="fed-directory-heading"><div><h3>Agents across this connection</h3>
            <p>${automatic ? `Choose which agents ${peerName} can find. Memory sharing has its own controls.` : (automatic === false ? 'Update this peer for automatic discovery and messaging. Existing shared contacts are listed here.' : 'Checking the connection’s messaging capabilities…')}</p></div>
        </div>
        <div class="fed-directory-tabs" role="group" aria-label="Agent directories">
            <button type="button" aria-pressed=${side === 'local'} onClick=${() => chooseSide('local')}>Your agents${visibilityReady && html`<span>${roster.length}</span>`}${visibilityDirty && html`<small>Unsaved</small>`}</button>
            <button type="button" aria-pressed=${side === 'remote'} onClick=${() => chooseSide('remote')}>Agents on ${peerName}</button>
        </div>
        <article class="fed-directory-node">
            <header class="fed-directory-node-heading">
                <div><h4>${side === 'local' ? localName || 'This SAGE' : peerName}</h4>
                    <p>${operatorRoster ? `Visible agents appear in ${peerName}’s searches and directory.` : 'Copy an address to send work from your agent’s messaging tool.'}</p></div>
                ${operatorRoster && html`<span class="fed-visibility-count">${visibilityReady ? `${visibleCount} ${visibilityDirty ? 'will be visible' : 'visible'} · ${roster.length - visibleCount} hidden` : 'Loading visibility…'}</span>`}
            </header>
            ${operatorRoster && html`<div class="fed-visibility-policy">
                <span>${visibilityReady ? (policy.mode === 'all' ? 'All agents visible, including future agents' : policy.mode === 'none' ? 'All agents hidden' : 'Only selected agents visible') : 'Loading eligible agents…'}</span>
                <div><button type="button" class="btn" disabled=${visibilityDisabled || policy?.mode === 'all'} onClick=${() => changeAll(true)}>Show all agents</button>
                    <button type="button" class="btn" disabled=${visibilityDisabled || policy?.mode === 'none'} onClick=${() => changeAll(false)}>Hide all agents</button></div>
            </div>`}
            <div class="fed-directory-toolbar">
                <label class="fed-agent-search">Find an agent<input type="search" placeholder="Name, provider, or agent ID" value=${query} onInput=${e => setQuery(e.target.value)} /></label>
                <label class="fed-agent-provider">Provider<select aria-label="Filter by provider" value=${provider} onChange=${e => setProvider(e.target.value)}>
                    <option value="">All providers</option>${providers.map(value => html`<option key=${value} value=${value}>${value}</option>`)}</select></label>
            </div>
            ${operatorRoster && html`<div class="fed-visibility-filters" role="group" aria-label="Filter by visibility">
                ${[['all', 'All agents', roster.length], ['visible', 'Visible', savedVisibleCount], ['hidden', 'Hidden', roster.length - savedVisibleCount]].map(([value, label, count]) => html`<button type="button" key=${value} aria-pressed=${visibilityFilter === value} disabled=${!visibilityReady} onClick=${() => setVisibilityFilter(value)}>${label}<span>${visibilityReady ? count : '…'}</span></button>`)}
            </div>`}
            ${operatorRoster && visibilityDirty && visibilityFilter !== 'all' && html`<p class="fed-directory-filter-note">Visibility filters update after you save.</p>`}
            <div class="fed-directory-results"><span>${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}${filtersActive ? ` matching of ${allAgents.length}` : (operatorRoster ? ' on this SAGE' : ' on this page')}</span>
                ${filtersActive && html`<button type="button" class="fed-directory-clear" onClick=${clearFilters}>Clear filters</button>`}
                ${operatorRoster && filtersActive && html`<div class="fed-directory-bulk">
                    <button type="button" class="btn" disabled=${visibilityDisabled || !agents.length || matchingVisible === agents.length} onClick=${() => changeVisibility(agents.map(agent => agent.agent_id), true)}>Show matching</button>
                    <button type="button" class="btn" disabled=${visibilityDisabled || !matchingVisible} onClick=${() => changeVisibility(agents.map(agent => agent.agent_id), false)}>Hide matching</button>
                </div>`}
            </div>
            <div class="fed-directory-agents" aria-label=${operatorRoster ? 'Agent visibility choices' : 'Available agent contacts'}>${agents.map(agent => {
                const label = agent.display_name || agent.name || agent.registered_name || agent.agent_id.slice(0, 12);
                const visible = federationAgentVisible(policy, agent.agent_id);
                const changed = operatorRoster && visible !== federationAgentVisible(savedVisibility, agent.agent_id);
                return html`<div class=${`fed-directory-agent${operatorRoster && visible ? ' is-visible' : ''}${changed ? ' is-changed' : ''}`} key=${agent.agent_id}>
                    <span class="fed-agent-avatar" aria-hidden="true">${label.replace(/^(codex|claude-code|agent)\//, '').slice(0, 1).toUpperCase()}</span>
                    <div class="fed-agent-identity"><strong>${label}${operatorRoster && agent.messaging_blocked && html`<span class="fed-agent-not-accepting" title="Messaging is blocked by this agent’s security policy.">Not accepting</span>`}</strong>
                        <small>${agent.provider || 'Agent'}<span aria-hidden="true"> · </span><code title=${agent.agent_id}>${agent.agent_id.slice(0, 8)}</code>${agent.registered_name && agent.registered_name !== label && html`<span class="fed-agent-registered"> · ${agent.registered_name}</span>`}</small></div>
                    ${operatorRoster ? html`<label class="fed-agent-toggle fed-agent-visible">
                        <span>${visible ? 'Visible' : 'Hidden'}${changed && html`<small>Unsaved</small>`}</span>
                        <input type="checkbox" role="switch" checked=${visible} disabled=${visibilityDisabled}
                            aria-label=${`Make ${label} visible to ${peerName}`}
                            onChange=${event => changeVisibility([agent.agent_id], event.target.checked)} />
                        <span class="fed-visibility-switch" aria-hidden="true"></span>
                    </label>` : html`<span class="fed-agent-messaging">${grant && grant.paused ? 'Connection paused' : agent.accepting && agent.available ? 'Messaging allowed' : 'Messaging blocked'}</span>
                        <button type="button" class="btn fed-address-copy" disabled=${!agent.address} aria-label=${`Copy address for ${label} on ${side === 'local' ? localName || 'this SAGE' : peerName}`} onClick=${() => copy(agent, side === 'local' ? localName || 'this SAGE' : peerName)}>${copied === agent.address ? 'Copied' : 'Copy address'}</button>`}
                </div>`;
            })}</div>
            ${!agents.length && html`<div class="fed-directory-empty"><strong>${operatorRoster && !visibilityReady ? 'Agent visibility is unavailable' : filtersActive ? 'No agents match these filters' : 'No agents listed'}</strong>
                <p>${operatorRoster && !visibilityReady ? 'Refresh to load the current agents and visibility policy.' : filtersActive ? 'Try another name or clear the filters.' : operatorRoster ? 'Active, enrolled agents will appear here.' : 'This page has no available contacts. Check the next page if one is offered.'}</p></div>`}
            ${operatorRoster && html`<div class="fed-visibility-save" aria-live="polite">
                <div><strong>${visibility.saving ? 'Saving visibility…' : !visibilityReady ? 'Visibility unavailable' : visibilityDirty ? (changedCount ? `${changedCount} ${changedCount === 1 ? 'agent changed' : 'agents changed'}` : 'Visibility mode changed') : 'Visibility saved'}</strong>
                    <span>${visibilityDirty ? 'Review your choices, then save for this connection.' : 'Visibility grants discovery only. Memory access is separate.'}</span></div>
                <div class="fed-visibility-save-actions"><button type="button" class="btn" disabled=${!visibilityDirty || visibility.saving} onClick=${() => setVisibilityDraft(null)}>Discard</button>
                    <button type="button" class="btn btn-primary" disabled=${!visibilityDirty || visibility.saving} onClick=${() => visibility.save(policy.mode, policy.agent_ids)}>Save visibility</button></div>
            </div>
                ${visibility.error && html`<div class="fed-visibility-error" role="alert">${visibility.error}<button type="button" class="btn" disabled=${visibility.saving} onClick=${visibility.refresh}>Refresh visibility</button></div>`}`}
            ${!operatorRoster && html`<div class="fed-directory-pagination">
                ${activePage && html`<button type="button" class="btn" disabled=${!!loading} onClick=${() => setPages(current => { const next = { ...current }; delete next[side]; return next; })}>First agents</button>`}
                ${activePage && activePage.error && html`<span role="status">This page could not be refreshed.</span><button type="button" class="btn" disabled=${!!loading} onClick=${() => more(side, activePage.cursor)}>Retry page</button>`}
                ${grant && grant.next_cursor && html`<button type="button" class="btn" disabled=${!!loading} onClick=${() => more(side, grant.next_cursor)}>${loading === side ? 'Loading…' : 'Next agents'}</button>`}
            </div>
                <p class="fed-directory-page-note">Search covers this page. Being listed does not mean an agent is running.</p>`}
        </article>
        ${showSharing && html`<details class="fed-directory-sharing">
            <summary>Share memory with ${peerName} — optional</summary>
            <p>Select domains together, then choose Read, Copy, or Clear domain permissions. You can also drag a domain or your selection onto an area. Changes stay in the permission draft until you save.</p>
            <label>Find a domain<input type="search" value=${domainQuery} onInput=${e => { setDomainQuery(e.target.value); setDomainLimit(24); }} /></label>
            <div class="fed-directory-domain-actions"><button type="button" class="btn" disabled=${disabled || !domains.length} onClick=${() => setSelected(domains)}>Select matching domains (${domains.length})</button>
                <button type="button" class="btn" disabled=${!selected.length} onClick=${() => setSelected([])}>Clear selection</button></div>
            <div class="fed-directory-domains">${domains.slice(0, domainLimit).map(domain => html`<label class="fed-directory-domain" key=${domain} draggable=${!disabled}
                onDragStart=${e => { e.dataTransfer.setData('application/x-sage-domains', JSON.stringify(selected.includes(domain) ? selected : [domain])); e.dataTransfer.effectAllowed = 'copy'; }}>
                <input type="checkbox" checked=${selected.includes(domain)} disabled=${disabled} onChange=${e => setSelected(e.target.checked ? [...selected, domain] : selected.filter(item => item !== domain))} />${domain}<small>${draft?.[domain]?.read ? 'Read ' : ''}${draft?.[domain]?.copy ? 'Copy' : ''}${!draft?.[domain]?.read && !draft?.[domain]?.copy ? 'Not shared' : ''}</small></label>`)}</div>
            ${domains.length > domainLimit && html`<button type="button" class="btn" onClick=${() => setDomainLimit(domainLimit + 24)}>Show more domains</button>`}
            <div class="fed-directory-dropzones">${['read', 'copy', 'remove'].map(permission => html`<button type="button" class="fed-directory-dropzone" disabled=${disabled} key=${permission}
                onDragOver=${e => { if (!disabled && Array.from(e.dataTransfer.types).includes('application/x-sage-domains')) e.preventDefault(); }}
                onDrop=${e => { e.preventDefault(); try { const items = JSON.parse(e.dataTransfer.getData('application/x-sage-domains')); if (Array.isArray(items)) stage(items.filter(item => typeof item === 'string' && Object.hasOwn(catalog, item) && catalog[item].can_share !== false), permission); } catch {} }}
                onClick=${() => stage(selected, permission)}>
                <strong>${permission === 'remove' ? 'Clear domain permissions' : permission === 'read' ? 'Live Read' : 'Offer Copy'}</strong><span>${permission === 'remove' ? 'Clear these Read/Copy choices after saving. Other domain or agent sharing may still allow access. Existing copies remain.' : permission === 'read' ? 'They may query these memories here.' : 'They may keep local copies after subscribing.'}</span>
                <small>${selected.length ? `Add ${selected.length} selected domains to draft` : 'Drop domains here'}</small></button>`)}</div>
        </details>`}
        ${notice && html`<p role="status" aria-live="polite">${notice}</p>`}
    </section>`;
}
