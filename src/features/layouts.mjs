/** Native saved-layout operations. No Desktop shell access or caller-supplied code.
 * Protocol research: TradingView's Save-As controller, as documented by
 * pbajkovic-hub/tv-cdp-mcp; independently implemented with identity verification.
 */
import { createHash } from 'node:crypto';
import { ToolError } from '../core/errors.mjs';

const text = { type: 'string', minLength: 1, maxLength: 200 };
const layoutId = { type: 'string', pattern: '^[A-Za-z0-9_-]{6,64}$' };
const keySchema = { type: 'string', minLength: 6, maxLength: 160 };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const canonical = value => JSON.stringify(value, (_key, val) => val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().map(key => [key, val[key]])) : val);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const SOURCE_FINGERPRINT_VERSION = 'user-config-v1';
const DIRECT_CLONE_PROTOCOL = 'desktop-direct-no-autoopen-v1';
export function sourceConfigurationFingerprint(panes) {
  const normalized = Array.isArray(panes) ? panes.map(pane => ({ ...pane,
    studies: Array.isArray(pane.studies) ? pane.studies.map(study => {
      const viewport = study.viewport_inputs;
      const valid = study.viewport_inputs_metadata_verified === true && Array.isArray(viewport)
        && viewport.every(input => ['first_visible_bar_time', 'last_visible_bar_time'].includes(input?.id)
          && typeof input.value === 'number' && Number.isSafeInteger(input.value))
        && new Set(viewport.map(input => input.id)).size === viewport.length;
      return valid ? { ...study, viewport_inputs: viewport.map(input => ({ ...input, value: '[viewport]' })) } : study;
    }) : pane.studies,
  })) : panes;
  return digest(normalized);
}
const sourceFingerprintMatch = (record, panes) => !record?.source_fingerprint ? null
  : record.source_fingerprint === (record.source_fingerprint_version === SOURCE_FINGERPRINT_VERSION ? sourceConfigurationFingerprint(panes) : digest(panes));
const sourceFingerprintIssue = (record, matches) => record?.source_fingerprint_version === SOURCE_FINGERPRINT_VERSION && matches === false
  ? 'source changed since clone submission' : 'legacy or missing source fingerprint cannot verify source stability';

export function chartUrl(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new ToolError('INVALID_ARGUMENT', 'A saved TradingView layout ID is required.');
  return `https://www.tradingview.com/chart/${id}/`;
}

/** All code crossing the browser boundary is this fixed, reviewed function. */
export async function layoutPage({ operation, data = {} }) {
  const api = window.TradingViewApi;
  if (!api) throw new Error('CAPABILITY_UNAVAILABLE: TradingView chart API is not loaded.');
  const watched = item => item && typeof item.value === 'function' ? item.value() : item ?? null;
  const service = api.getSaveChartService?.();
  const collection = api._chartWidgetCollection;
  const chart = api.activeChart?.() || api._activeChartWidgetWV?.value?.();
  const meta = collection?.metaInfo;
  const id = service?.layoutId?.() ?? watched(meta?.uid);
  const current = () => ({
    layout_id: id == null ? null : String(id),
    name: watched(meta?.name) ?? api.layoutName?.() ?? null,
    read_only: typeof collection?.readOnly === 'function' ? !!collection.readOnly() : null,
    unsaved_changes: typeof service?.hasChanges === 'function' ? !!service.hasChanges() : null,
    symbol: chart?.symbol?.() ?? null,
    resolution: chart?.resolution?.() ?? null,
    chart_type: chart?.chartType?.() ?? null,
    href: location.origin + location.pathname,
  });
  const plain = (value, depth = 10, seen = new WeakSet()) => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (value === undefined || typeof value === 'function') return null;
    if (depth === 0 || seen.has(value)) throw new Error('A chart setting is cyclic or exceeds the capture depth.');
    seen.add(value);
    const out = Array.isArray(value) ? value.map(v => plain(v, depth - 1, seen))
      : Object.fromEntries(Object.keys(value).map(k => [k, plain(value[k], depth - 1, seen)]));
    seen.delete(value);
    return out;
  };
  const saved = async () => {
    if (typeof api.getSavedCharts !== 'function') throw new Error('CAPABILITY_UNAVAILABLE: saved-layout listing is unavailable.');
    const rows = await api.getSavedCharts();
    if (!Array.isArray(rows)) throw new Error('UNEXPECTED_RESPONSE: saved-layout list was not an array.');
    return rows.map(row => ({
      numeric_id: row.id == null ? null : String(row.id),
      layout_id: row.url == null ? null : String(row.url),
      name: row.name ?? row.title ?? null,
      symbol: row.pro_symbol ?? row.symbol ?? null,
      resolution: row.resolution ?? row.interval ?? null,
      modified: row.modified_iso ?? row.modified ?? null,
      favorite: !!row.favorite,
    }));
  };
  if (operation === 'get') return current();
  if (operation === 'list') return saved();
  if (operation === 'saved_fingerprint' || operation === 'compare_saved') {
    // Keep private saved chart payloads inside the authenticated page. Only
    // hashes and explicit verification results cross the browser boundary.
    const canonicalSaved = value => JSON.stringify(value, (_key, val) => val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map(key => [key, val[key]])) : val);
    const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalSaved(value))))].map(n => n.toString(16).padStart(2, '0')).join('');
    const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const validUid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(value);
    const validNumber = value => typeof value === 'number' ? Number.isSafeInteger(value) && value > 0
      : typeof value === 'string' && /^[1-9]\d*$/.test(value);
    const unavailableInventory = () => ({ available: false, inventory_verified: false, contents_verified: false,
      reason: 'saved_drawing_inventory_unavailable_or_unverified' });
    const readInventory = async (uid, savedContent) => {
      try {
        const chartId = savedContent.charts[0]?.chartId;
        if (typeof chartId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chartId) || typeof api.getChartStorage !== 'function') return unavailableInventory();
        const storage = await api.getChartStorage();
        if (typeof storage?.getLayoutDrawingsSizeInfo !== 'function') return unavailableInventory();
        const dto = await storage.getLayoutDrawingsSizeInfo(uid, chartId);
        const integer = (value, max) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
        const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
        if (!exactKeys(dto, ['charts', 'countSourcesTotal', 'limitBytesTotal', 'sizeBytesTotal']) || !(dto.charts instanceof Map)
          || dto.charts.size === 0 || dto.charts.size > 100 || !integer(dto.countSourcesTotal, 100000) || dto.countSourcesTotal === 0
          || !integer(dto.limitBytesTotal, Number.MAX_SAFE_INTEGER) || !integer(dto.sizeBytesTotal, Number.MAX_SAFE_INTEGER)) return unavailableInventory();
        const charts = []; let count = 0, buckets = 0, bytes = 0;
        for (const [savedChartId, bySymbol] of dto.charts) {
          if (typeof savedChartId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(savedChartId) || !(bySymbol instanceof Map) || bySymbol.size === 0 || bySymbol.size > 10000) return unavailableInventory();
          const symbols = [];
          for (const [symbol, bucket] of bySymbol) {
            if (++buckets > 10000 || typeof symbol !== 'string' || symbol.length === 0 || symbol.length > 4096 || /[\u0000-\u001f]/.test(symbol)
              || !exactKeys(bucket, ['countSources', 'sizeBytes', 'ids']) || !integer(bucket.countSources, 100000) || !integer(bucket.sizeBytes, 512 * 1024 * 1024)
              || !Array.isArray(bucket.ids) || bucket.ids.length > 100000 || bucket.ids.length !== bucket.countSources
              || !bucket.ids.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value))
              || new Set(bucket.ids).size !== bucket.ids.length) return unavailableInventory();
            count += bucket.countSources; bytes += bucket.sizeBytes;
            if (count > 100000 || bytes > 512 * 1024 * 1024) return unavailableInventory();
            symbols.push({ symbol, count: bucket.countSources, bytes: bucket.sizeBytes, ids: [...bucket.ids].sort() });
          }
          symbols.sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
          charts.push({ chart_id: savedChartId, symbols });
        }
        if (count !== dto.countSourcesTotal) return unavailableInventory();
        charts.sort((a, b) => a.chart_id < b.chart_id ? -1 : a.chart_id > b.chart_id ? 1 : 0);
        return { available: true, sha256: await sha({ charts, count }), chart_count: charts.length, bucket_count: buckets, source_count: count,
          contents_verified: false };
      } catch { return unavailableInventory(); }
    };
    const stableInventory = (first, second) => first?.available === true && second?.available === true && canonicalSaved(first) === canonicalSaved(second)
      ? { ...first, stable_reads_verified: true } : unavailableInventory();
    const layoutFingerprint = ({ drawings_inventory: ignoredInventory, ...fingerprint }) => fingerprint;
    const readSaved = async (uid, numericId, name) => {
      if (!validUid(uid) || !validNumber(numericId) || typeof name !== 'string') throw new Error('SAVED_LAYOUT_IDENTITY_UNVERIFIED');
      const response = await fetch(`https://www.tradingview.com/chart/${uid}/json/`, { credentials: 'include', redirect: 'error' });
      if (!response.ok) throw new Error('SAVED_LAYOUT_HTTP_ERROR');
      if (Number(response.headers?.get?.('content-length')) > 4 * 1024 * 1024) throw new Error('SAVED_LAYOUT_PAYLOAD_LIMIT');
      const raw = await response.text();
      if (raw.length > 4 * 1024 * 1024) throw new Error('SAVED_LAYOUT_PAYLOAD_LIMIT');
      let row, content, studyMeta;
      try {
        row = JSON.parse(raw);
        if (!object(row) || typeof row.content !== 'string' || typeof row.content_study_meta !== 'string') throw new Error();
        content = JSON.parse(row.content); studyMeta = JSON.parse(row.content_study_meta);
      } catch { throw new Error('SAVED_LAYOUT_SCHEMA_UNVERIFIED'); }
      if (row.uid !== uid || !validNumber(row.id) || String(row.id) !== String(numericId) || row.name !== name || !object(content) || content.name !== row.name) throw new Error('SAVED_LAYOUT_IDENTITY_UNVERIFIED');
      if (!Array.isArray(content.charts) || content.charts.length === 0 || !content.charts.every(object) || !object(studyMeta)) throw new Error('SAVED_LAYOUT_SCHEMA_UNVERIFIED');
      const { name: ignoredName, ...configuration } = content;
      return { layout_id: uid, numeric_id: String(row.id),
        content_sha256: await sha(content), configuration_sha256: await sha(configuration),
        study_meta_sha256: await sha(studyMeta), pane_count: content.charts.length,
        drawings_inventory: await readInventory(uid, content) };
    };
    const sourceArgs = [data.source_layout_id, data.source_numeric_id, data.source_name];
    if (operation === 'saved_fingerprint') {
      const first = await readSaved(...sourceArgs), second = await readSaved(...sourceArgs);
      if (canonicalSaved(layoutFingerprint(first)) !== canonicalSaved(layoutFingerprint(second))) throw new Error('SAVED_LAYOUT_CHANGED_DURING_READ');
      return { available: true, ...first, drawings_inventory: stableInventory(first.drawings_inventory, second.drawings_inventory), drawings_covered: false,
        verification_scope: 'Stable saved layout content and study metadata; separate line-tool drawing state and current unsaved state are not captured.' };
    }
    if (data.source_layout_id === data.copy_layout_id || String(data.source_numeric_id) === String(data.copy_numeric_id)) throw new Error('SAVED_LAYOUT_NOT_INDEPENDENT');
    const copyArgs = [data.copy_layout_id, data.copy_numeric_id, data.copy_name];
    const [source, destination] = await Promise.all([readSaved(...sourceArgs), readSaved(...copyArgs)]);
    const [sourceAgain, destinationAgain] = await Promise.all([readSaved(...sourceArgs), readSaved(...copyArgs)]);
    const sourceStable = canonicalSaved(layoutFingerprint(source)) === canonicalSaved(layoutFingerprint(sourceAgain));
    const destinationStable = canonicalSaved(layoutFingerprint(destination)) === canonicalSaved(layoutFingerprint(destinationAgain));
    const stable = sourceStable && destinationStable;
    source.drawings_inventory = stableInventory(source.drawings_inventory, sourceAgain.drawings_inventory);
    destination.drawings_inventory = stableInventory(destination.drawings_inventory, destinationAgain.drawings_inventory);
    const baseline = data.source_baseline;
    const baselineValid = baseline?.available === true && baseline.layout_id === source.layout_id && baseline.numeric_id === source.numeric_id && /^[a-f0-9]{64}$/.test(baseline.content_sha256 ?? '') && /^[a-f0-9]{64}$/.test(baseline.study_meta_sha256 ?? '');
    const sourceUnchanged = baselineValid && sourceStable ? baseline.content_sha256 === source.content_sha256 && baseline.study_meta_sha256 === source.study_meta_sha256 : null;
    const contentEqual = source.configuration_sha256 === destination.configuration_sha256;
    const metaEqual = source.study_meta_sha256 === destination.study_meta_sha256;
    const inventoriesAvailable = source.drawings_inventory.available === true && destination.drawings_inventory.available === true;
    const inventoryEqual = inventoriesAvailable ? source.drawings_inventory.sha256 === destination.drawings_inventory.sha256 : null;
    const baselineInventory = baseline?.drawings_inventory;
    const inventorySourceUnchanged = baselineValid && baselineInventory?.available === true && /^[a-f0-9]{64}$/.test(baselineInventory.sha256 ?? '') && source.drawings_inventory.available === true
      ? baselineInventory.sha256 === source.drawings_inventory.sha256 : null;
    const inventoryComparison = { available: inventoriesAvailable, inventory_verified: stable && inventoryEqual === true && inventorySourceUnchanged === true,
      current_saved_inventory_equal: inventoryEqual, source_unchanged_since_baseline: inventorySourceUnchanged,
      source: source.drawings_inventory, destination: destination.drawings_inventory, contents_verified: false,
      scope: 'Stable saved drawing inventory counts, per-bucket sizes and exact ID membership only; individual drawing contents are not read or verified. Physical account size and limit totals are not compared.' };
    return { available: true, saved_configuration_verified: stable && sourceUnchanged === true && contentEqual && metaEqual,
      current_saved_configuration_equal: stable && contentEqual && metaEqual,
      stable_reads_verified: stable, source_unchanged_since_baseline: sourceUnchanged,
      source_stability_unverified: sourceUnchanged === null,
      content_equal_excluding_root_name: contentEqual, study_metadata_equal: metaEqual,
      source, destination, excluded_fields: ['content.name'],
      saved_drawings_inventory_verification: inventoryComparison,
      drawings_covered: false, full_fidelity_verified: false,
      verification_scope: 'Saved layout content and study metadata; expected root name checked separately. Separate line-tool drawing state and current unsaved chart state are not covered.' };
  }
  if (operation === 'snapshot') {
    const result = { ...current(), panes: [], unverified_fields: [] };
    const widgets = collection?.getAll?.();
    const activeWidget = chart?._chartWidget;
    const paneWidgets = Array.isArray(widgets) && widgets.length ? widgets : [activeWidget];
    if (!Array.isArray(widgets) || !widgets.length) result.unverified_fields.push('pane_count');
    let layoutCode = watched(collection?._layoutType);
    if (typeof api.layout === 'function') layoutCode = api.layout();
    result.layout_code = typeof layoutCode === 'string' ? layoutCode : null;
    result.active_index = paneWidgets.indexOf(activeWidget);
    if (result.active_index < 0 || !activeWidget) result.active_index = null;
    if (result.layout_code === null) result.unverified_fields.push('layout_code');
    if (result.active_index === null) result.unverified_fields.push('active_index');
    for (let index = 0; index < paneWidgets.length; index++) {
      const widget = paneWidgets[index];
      let facade;
      try { facade = typeof api.chart === 'function' ? api.chart(index) : widget === activeWidget ? chart : null; } catch { /* Unavailable slots remain unverified. */ }
      if (!widget || facade?._chartWidget !== widget) facade = null;
      const pane = { index, symbol: facade?.symbol?.() ?? null,
        resolution: facade?.resolution?.() ?? null,
        chart_type: facade?.chartType?.() ?? null, studies: null, drawings: null };
      if (!facade) result.unverified_fields.push(`panes.${index}.facade`);
      for (const field of ['symbol', 'resolution', 'chart_type']) if (pane[field] === null) result.unverified_fields.push(`panes.${index}.${field}`);
      try {
        const studies = facade?.getAllStudies?.();
        if (!Array.isArray(studies)) throw new Error('Study listing is unavailable.');
        pane.studies = [];
        for (let n = 0; n < studies.length; n++) {
          const study = studies[n];
          const entry = { name: study.name ?? study.title ?? null, inputs: null, properties: null,
            viewport_inputs: null, viewport_inputs_metadata_verified: null };
          try {
            const handle = facade.getStudyById(study.id);
            entry.inputs = plain(handle.getInputValues());
            if (Array.isArray(entry.inputs)) {
              const viewportIds = ['first_visible_bar_time', 'last_visible_bar_time'];
              const candidates = entry.inputs.filter(input => viewportIds.includes(input?.id));
              entry.viewport_inputs = [];
              entry.viewport_inputs_metadata_verified = true;
              if (candidates.length) {
                let definitions;
                try { definitions = handle.getInputsInfo?.(); } catch { /* Unknown metadata must not hide an input. */ }
                const classified = [];
                for (const input of candidates) {
                  const matches = Array.isArray(definitions) ? definitions.filter(info => info?.id === input.id) : [];
                  const definition = matches.length === 1 ? matches[0] : null;
                  if (!definition || typeof definition.type !== 'string' || typeof definition.isHidden !== 'boolean' || entry.inputs.filter(item => item?.id === input.id).length !== 1) {
                    entry.viewport_inputs_metadata_verified = false;
                  } else if (definition.isHidden === true && definition.type === 'integer') {
                    if (typeof input.value !== 'number' || !Number.isSafeInteger(input.value)) entry.viewport_inputs_metadata_verified = false;
                    else classified.push(input);
                  }
                }
                if (entry.viewport_inputs_metadata_verified) {
                  entry.viewport_inputs = classified;
                  entry.inputs = entry.inputs.filter(input => !classified.includes(input));
                } else entry.viewport_inputs = null;
              }
            }
            if (typeof handle.getProperties === 'function') entry.properties = plain(handle.getProperties());
          } catch { /* Missing fields are recorded individually below. */ }
          if (entry.inputs === null) result.unverified_fields.push(`panes.${index}.studies.${n}.inputs`);
          if (entry.viewport_inputs_metadata_verified !== true) result.unverified_fields.push(`panes.${index}.studies.${n}.viewport_inputs_metadata`);
          if (entry.properties === null) result.unverified_fields.push(`panes.${index}.studies.${n}.properties`);
          pane.studies.push(entry);
        }
      } catch { result.unverified_fields.push(`panes.${index}.studies`); }
      if (typeof facade?.getAllShapes === 'function') {
        try {
          const shapes = facade.getAllShapes();
          if (!Array.isArray(shapes)) throw new Error('Drawing listing is unavailable.');
          const validNativePoints = value => Array.isArray(value) && value.length > 0 && value.length <= 10000 && value.every(point => point && typeof point === 'object' && !Array.isArray(point)
            && Object.keys(point).sort().join(',') === 'interval,offset,price,time_t'
            && ['time_t', 'offset', 'price'].every(key => typeof point[key] === 'number' && Number.isFinite(point[key]))
            && typeof point.interval === 'string' && point.interval.length > 0);
          const captures = shapes.map(shape => {
            const handle = facade.getShapeById(shape.id), source = handle?._source;
            const capture = { shape, handle, nativePresent: !!source, normalized: null, state: null };
            let identity = false;
            try { identity = typeof source?.id === 'function' && source.id() === shape.id; } catch { /* Do not use an unbound source. */ }
            if (identity) {
              try { const points = plain(source.normalizedPoints?.()); if (validNativePoints(points)) capture.normalized = points; } catch { /* Entire pane falls back if this representation is incomplete. */ }
              try { const points = plain(source.state?.()?.points); if (validNativePoints(points)) capture.state = points; } catch { /* Entire pane falls back if this representation is incomplete. */ }
            }
            return capture;
          });
          const nativeMethod = captures.length && captures.every(item => item.normalized !== null) ? 'normalized'
            : captures.length && captures.every(item => item.state !== null) ? 'state' : null;
          pane.drawing_points_representation = nativeMethod ? 'native_normalized' : 'public_time';
          pane.drawing_points_source = nativeMethod === 'normalized' ? 'normalizedPoints' : nativeMethod === 'state' ? 'state.points' : 'getPoints';
          if (!nativeMethod && captures.some(item => item.nativePresent)) result.unverified_fields.push(`panes.${index}.drawings.native_points`);
          pane.drawings = captures.map(({ shape, handle, ...capture }) => {
            const points = nativeMethod ? capture[nativeMethod] : plain(handle.getPoints());
            if (!Array.isArray(points)) throw new Error('Drawing points are unavailable.');
            return { name: shape.name, points, properties: plain(handle.getProperties()) };
          });
        } catch { result.unverified_fields.push(`panes.${index}.drawings`); }
      } else result.unverified_fields.push(`panes.${index}.drawings`);
      result.panes.push(pane);
    }
    return result;
  }
  if (operation === 'copy') {
    if (data.desktop_direct === true) {
      const sourceId = current().layout_id;
      if (typeof data.name !== 'string' || data.name.length === 0 || data.name.length > 200 || !/^[A-Za-z0-9_-]{6,64}$/.test(data.source_layout_id ?? '') || sourceId !== data.source_layout_id) throw new Error('CLONE_SOURCE_IDENTITY_UNVERIFIED');
      if (typeof service?.hasChanges !== 'function' || service.hasChanges() !== false) throw new Error('CLONE_SOURCE_NOT_CLEAN');
      // Desktop's legacy controller launches a delayed tab without awaiting its
      // clone POST. Submit this exact saved-layout clone directly and leave all
      // tab creation to the caller after independent saved-ID reconciliation.
      const response = await fetch(`${location.origin}/charts/${sourceId}/clone/`, { method: 'POST', body: JSON.stringify({ name: data.name }), credentials: 'include', redirect: 'error' });
      if (!response.ok) throw new Error('CLONE_REQUEST_REJECTED');
      const returnedLocation = response.headers?.get?.('location');
      if (typeof returnedLocation !== 'string' || !returnedLocation) throw new Error('CLONE_RESPONSE_UNVERIFIED');
      let destination;
      try { destination = new URL(returnedLocation, location.origin); } catch { throw new Error('CLONE_RESPONSE_UNVERIFIED'); }
      const match = /^\/chart\/([A-Za-z0-9_-]{6,64})\/?$/.exec(destination.pathname);
      if (destination.origin !== location.origin || destination.username || destination.password || destination.search || destination.hash || !match || match[1] === sourceId) throw new Error('CLONE_RESPONSE_UNVERIFIED');
      return { submitted: true, copy_layout_id: match[1], transport: 'native_saved_layout_clone' };
    }
    const controller = service?.getSaveAsController?.();
    if (typeof controller?._actionHandler === 'function') await controller._actionHandler({ newValue: data.name, dialogClose() {} });
    else if (typeof controller?._doCloneCurrentLayout === 'function') await controller._doCloneCurrentLayout(data.name);
    else throw new Error('CAPABILITY_UNAVAILABLE: native Make a copy controller is unavailable.');
    return { submitted: true };
  }
  if (operation === 'create') {
    if (typeof api.createNewLayout !== 'function') throw new Error('CAPABILITY_UNAVAILABLE: native new-layout API is unavailable.');
    const newId = await api.createNewLayout();
    if (newId == null) throw new Error('UNCERTAIN_MUTATION: new-layout API returned no ID. Inspect saved layouts before retrying.');
    return { layout_id: String(newId) };
  }
  if (operation === 'save') {
    if (typeof api.saveChartToServer !== 'function') throw new Error('CAPABILITY_UNAVAILABLE: native layout save is unavailable.');
    api.saveChartToServer(undefined, undefined, data.name ? { chartName: data.name } : undefined);
    return { submitted: true, layout_id: current().layout_id };
  }
  if (operation === 'rename') {
    const controller = service?.getRenameController?.();
    if (typeof controller?._actionHandler !== 'function') throw new Error('CAPABILITY_UNAVAILABLE: native rename controller is unavailable.');
    await controller._actionHandler({ newValue: data.name, dialogClose() {} });
    return { submitted: true };
  }
  if (operation === 'delete') {
    if (typeof api.removeChartFromServer !== 'function') throw new Error('CAPABILITY_UNAVAILABLE: native layout deletion is unavailable.');
    await api.removeChartFromServer(data.layout_id);
    return { submitted: true };
  }
  if (operation === 'navigate') {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(data.layout_id)) throw new Error('INVALID_ARGUMENT: invalid layout ID.');
    location.assign(`https://www.tradingview.com/chart/${data.layout_id}/`);
    return { submitted: true };
  }
  throw new Error('INVALID_OPERATION: unknown layout operation.');
}

const page = (ctx, operation, data = {}) => ctx.callPage(layoutPage, { operation, data }, { timeoutMs: 20000 });
const savedIdentity = (row, prefix) => ({ [`${prefix}_layout_id`]: row?.layout_id, [`${prefix}_numeric_id`]: row?.numeric_id, [`${prefix}_name`]: row?.name });
const unavailableSavedVerification = () => ({ available: false, saved_configuration_verified: false,
  source_unchanged_since_baseline: null, source_stability_unverified: true,
  drawings_covered: false, full_fidelity_verified: false,
  saved_drawings_inventory_verification: { available: false, inventory_verified: false, contents_verified: false, reason: 'saved_drawing_inventory_unavailable_or_unverified' },
  reason: 'saved_payload_unavailable_or_unverified', verification_scope: 'Saved layout-content verification unavailable; drawing state is separate and no full-fidelity claim is made.' });
async function savedFingerprint(ctx, row) {
  try {
    const result = await page(ctx, 'saved_fingerprint', savedIdentity(row, 'source'));
    if (result?.available !== true || result.layout_id !== row?.layout_id || !/^[a-f0-9]{64}$/.test(result.content_sha256 ?? '') || !/^[a-f0-9]{64}$/.test(result.study_meta_sha256 ?? '')) throw new Error('unverified');
    return result;
  }
  catch { return { available: false, reason: 'saved_source_baseline_unavailable' }; }
}
async function savedComparison(ctx, source, copy, baseline) {
  try {
    const result = await page(ctx, 'compare_saved', { ...savedIdentity(source, 'source'), ...savedIdentity(copy, 'copy'), source_baseline: baseline });
    if (result?.available !== true || typeof result.saved_configuration_verified !== 'boolean' || ![true, false, null].includes(result.source_unchanged_since_baseline)) throw new Error('unverified');
    return result;
  }
  catch { return unavailableSavedVerification(); }
}
const targetIdOf = item => typeof item === 'string' ? item : item?.targetId ?? item?.target_id ?? item?.id;
const targetsArray = rows => Array.isArray(rows) ? rows : rows?.targets ?? [];
const targetMatches = (item, id) => {
  try { const url = new URL(item.url); return url.protocol === 'https:' && ['www.tradingview.com', 'tradingview.com'].includes(url.hostname) && url.pathname === `/chart/${id}/`; }
  catch { return false; }
};

export async function findLayoutContext(ctx, id, { open = true, preferredTargetId = null, beforeOpen, waitForExisting = false } = {}) {
  const selectTarget = async () => {
    const matches = targetsArray(await ctx.browser.listTargets()).filter(target => targetMatches(target, id));
    const preferred = preferredTargetId && matches.find(target => targetIdOf(target) === preferredTargetId);
    if (preferred) return targetIdOf(preferred);
    if (matches.length > 1) throw new ToolError('AMBIGUOUS_LAYOUT_TARGET', 'Multiple tabs show this exact saved layout; select a previously confirmed target before continuing.', { layout_id: id, target_count: matches.length });
    return targetIdOf(matches[0]);
  };
  let targetId = await selectTarget();
  if (!targetId && waitForExisting) targetId = await ctx.poll(selectTarget, value => typeof value === 'string' && value.length > 0,
    { timeoutMs: 45000, intervalMs: 500, description: 'reconcile an earlier tab-open intent without opening another tab' });
  if (!targetId && open) {
    if (beforeOpen) await beforeOpen();
    targetId = targetIdOf(await ctx.browser.openTarget(chartUrl(id), { sourceTargetId: ctx.targetId }));
  }
  if (!targetId) throw new ToolError('LAYOUT_NOT_OPEN', 'No browser tab for this saved layout was found.', { layout_id: id });
  const next = await ctx.forTarget(targetId, id);
  await ctx.poll(async () => {
    try { return await page(next, 'get'); } catch { return null; }
  }, row => row?.layout_id === id && !!row.symbol && !!row.resolution,
  { timeoutMs: 45000, intervalMs: 500, description: 'wait for exact saved layout to load' });
  return next;
}

async function findCopyContext(ctx, id, key, record) {
  const next = await findLayoutContext(ctx, id, {
    open: record.tab_open_intent !== true, waitForExisting: record.tab_open_intent === true,
    preferredTargetId: record.target_id ?? null,
    beforeOpen: async () => {
      record.tab_open_intent = true;
      await ctx.checkpoint(key, { ...record, stage: 'tab_open_submitted' });
    },
  });
  record.target_id = next.targetId;
  await ctx.checkpoint(key, { ...record, stage: 'created' });
  return next;
}

const normalInputs = inputs => Array.isArray(inputs)
  ? Object.fromEntries(inputs.map(input => [input.id, input.value])) : inputs;

// Comparison receipts must never echo chart text, private Pine payloads or settings.
// Equality still uses the complete values; these summaries are presentation only.
const comparisonSummary = value => ({
  type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
  sha256: digest({ value }),
});
const comparisonField = field => {
  if (typeof field === 'string' && field.length <= 160 && /^(?:symbol|resolution|chart_type|pane_count|layout_code|active_index|panes\.\d+(?:\.(?:symbol|resolution|chart_type|facade|study_count|studies|drawings)(?:\.(?:native_points|representation))?|\.studies\.\d+(?:\.(?:name|inputs|properties|viewport_inputs|viewport_inputs_metadata))?)?)$/.test(field)) return field;
  const namedStudy = typeof field === 'string' && /^panes\.(\d{1,12})\.study\.(.*)\.(inputs|properties)$/s.exec(field);
  if (namedStudy) return `panes.${namedStudy[1]}.study[sha256:${digest(namedStudy[2]).slice(0, 16)}].${namedStudy[3]}`;
  return `unverified[sha256:${digest({ field }).slice(0, 16)}]`;
};
const COMPARISON_RECEIPT_LIMIT = 100;

export function compareLayoutSnapshots(source, destination) {
  const mismatches = [];
  const viewportComparisons = [];
  const viewportCounts = { equal: 0, different: 0, unverified: 0 };
  const drawingComparisons = [];
  let mismatchCount = 0;
  const mismatch = (field, a, b) => {
    mismatchCount++;
    if (mismatches.length < COMPARISON_RECEIPT_LIMIT) mismatches.push({ field: comparisonField(field), source: comparisonSummary(a), destination: comparisonSummary(b) });
  };
  const unverified = [...(source.unverified_fields ?? []), ...(destination.unverified_fields ?? [])];
  const check = (field, a, b, required = true) => {
    if (a === null || a === undefined || b === null || b === undefined) {
      if (required) unverified.push(field);
    } else if (canonical(a) !== canonical(b)) mismatch(field, a, b);
  };
  if ('layout_code' in source || 'layout_code' in destination) check('layout_code', source.layout_code, destination.layout_code);
  check('pane_count', source.panes?.length, destination.panes?.length);
  for (let index = 0; index < (source.panes?.length ?? 0); index++) {
    const a = source.panes[index], b = destination.panes?.[index];
    if (!b) { mismatch(`panes.${index}`, 'present', 'missing'); continue; }
    check(`panes.${index}.symbol`, a.symbol, b.symbol);
    check(`panes.${index}.resolution`, a.resolution, b.resolution);
    // Legacy single-pane snapshots stored type only at the top level.
    const single = source.panes?.length === 1 && destination.panes?.length === 1;
    check(`panes.${index}.chart_type`, a.chart_type ?? (single ? source.chart_type : null), b.chart_type ?? (single ? destination.chart_type : null));
    check(`panes.${index}.study_count`, a.studies?.length, b.studies?.length);
    for (let n = 0; n < (a.studies?.length ?? 0); n++) {
      const x = a.studies[n], y = b.studies?.[n];
      if (!y) { mismatch(`panes.${index}.studies.${n}`, x.name, 'missing'); continue; }
      check(`panes.${index}.studies.${n}.name`, x.name, y.name);
      check(`panes.${index}.studies.${n}.inputs`, normalInputs(x.inputs), normalInputs(y.inputs));
      check(`panes.${index}.studies.${n}.properties`, x.properties, y.properties, false);
      if ('viewport_inputs' in x || 'viewport_inputs' in y) {
        const field = `panes.${index}.studies.${n}.viewport_inputs`;
        const verified = x.viewport_inputs_metadata_verified === true && y.viewport_inputs_metadata_verified === true && Array.isArray(x.viewport_inputs) && Array.isArray(y.viewport_inputs);
        const status = !verified ? 'unverified' : canonical(normalInputs(x.viewport_inputs)) === canonical(normalInputs(y.viewport_inputs)) ? 'equal' : 'different';
        viewportCounts[status]++;
        if (viewportComparisons.length < COMPARISON_RECEIPT_LIMIT) viewportComparisons.push({ field, status });
        if (!verified) unverified.push(`panes.${index}.studies.${n}.viewport_inputs_metadata`);
      }
    }
    const representation = value => value == null ? null : ['native_normalized', 'public_time'].includes(value) ? value : 'unknown';
    const sourceRepresentation = representation(a.drawing_points_representation), destinationRepresentation = representation(b.drawing_points_representation);
    const representationUnknown = sourceRepresentation === 'unknown' || destinationRepresentation === 'unknown' || (sourceRepresentation !== null || destinationRepresentation !== null) && sourceRepresentation !== destinationRepresentation;
    if (representationUnknown) unverified.push(`panes.${index}.drawings.representation`);
    else check(`panes.${index}.drawings`, a.drawings, b.drawings, false);
    if (drawingComparisons.length < COMPARISON_RECEIPT_LIMIT) drawingComparisons.push({ field: `panes.${index}.drawings`,
      source_representation: sourceRepresentation, destination_representation: destinationRepresentation,
      comparable: !representationUnknown && a.drawings !== null && a.drawings !== undefined && b.drawings !== null && b.drawings !== undefined });
  }
  const criticalMissing = unverified.filter(field => !/\.properties$|\.drawings$/.test(field));
  const safeUnverified = [...new Set(unverified.map(comparisonField))];
  return { chart_verified: mismatchCount === 0 && criticalMissing.length === 0,
    active_focus: { source_index: source.active_index ?? null, destination_index: destination.active_index ?? null,
      preserved: Number.isInteger(source.active_index) && Number.isInteger(destination.active_index) ? source.active_index === destination.active_index : null },
    full_fidelity_verified: false,
    readable_configuration_verified: mismatchCount === 0 && unverified.length === 0,
    full_fidelity_note: 'The native clone preserves the saved layout, but this comparison does not inspect every serialized layout field, synchronization option or internal strategy property.',
    mismatches, mismatch_count: mismatchCount, mismatches_truncated: mismatchCount > mismatches.length,
    unverified_fields: safeUnverified.slice(0, COMPARISON_RECEIPT_LIMIT), unverified_field_count: safeUnverified.length,
    unverified_fields_truncated: safeUnverified.length > COMPARISON_RECEIPT_LIMIT,
    comparison_values: 'sha256 summaries only; complete values were compared',
    viewport_inputs_comparison: { ...viewportCounts, details: viewportComparisons, truncated: Object.values(viewportCounts).reduce((sum, count) => sum + count, 0) > viewportComparisons.length,
      scope: 'Only exact first_visible_bar_time/last_visible_bar_time IDs with verified hidden integer metadata are separated from user configuration.' },
    drawings_comparison: drawingComparisons,
    drawings_scope: 'Visible runtime drawing inventory only; saved layout-content proof does not cover separate line-tool storage or the complete off-symbol archive.',
    checked: ['layout independence separately', 'symbols', 'resolutions', 'chart type', 'pane count', 'study names', 'study inputs', 'viewport inputs separately', 'readable properties and drawings in matching coordinate representations'] };
}

export async function saveLayout(args, ctx) {
  const before = await page(ctx, 'get');
  if (before.read_only) throw new ToolError('READ_ONLY_LAYOUT', 'This chart is read-only. Make a copy before saving.');
  await ctx.assertLayout(ctx.expectedLayoutId);
  await page(ctx, 'save', { name: args.name });
  const after = await ctx.poll(() => page(ctx, 'get'), row => row.layout_id === before.layout_id && row.unsaved_changes === false,
    { timeoutMs: 30000, intervalMs: 500, description: 'verify saved chart identity and cleared unsaved flag' });
  const listed = await ctx.poll(async () => (await page(ctx, 'list')).find(row => row.layout_id === before.layout_id),
    row => !!row && row.symbol === before.symbol && String(row.resolution) === String(before.resolution) &&
      (!args.name || row.name === args.name),
    { timeoutMs: 20000, intervalMs: 500, description: 'verify persisted layout symbol, resolution and requested name' });
  return { saved: true, layout_id: after.layout_id,
    previous_name: before.name, name: listed?.name ?? after.name, unsaved_changes: after.unsaved_changes,
    persisted_symbol: listed.symbol, persisted_resolution: listed.resolution,
    verified_from: 'native save service plus independent saved-layout list' };
}

const copyReconciliationError = (copyId, sourceId, error, savedVerification = unavailableSavedVerification()) => new ToolError('COPY_CREATED_UNVERIFIED',
  'The saved copy was created, but opening or verifying it failed. Reconcile this exact layout ID; retry only with the same idempotency key.',
  { created: true, source_layout_id: sourceId, layout_id: copyId, expected_layout_id: copyId,
    url: chartUrl(copyId), chart_verified: false, retry_with_same_key: true,
    verification_error: error?.code ?? 'VERIFICATION_FAILED', saved_configuration_verification: savedVerification,
    saved_drawings_inventory_verification: savedVerification.saved_drawings_inventory_verification,
    source_full_content_unchanged_verified: null,
    source_saved_layout_content_unchanged_verified: savedVerification.source_unchanged_since_baseline });

async function completeCopy(ctx, source, copy, savedBefore, key, requestHash, sourceBaseline, originalFingerprint) {
  if (!copy.layout_id || copy.layout_id === source.layout_id) throw new ToolError('COPY_NOT_INDEPENDENT', 'Copy does not have a distinct saved layout ID.');
  const sourceSaved = savedBefore.find(row => row.layout_id === source.layout_id);
  if (!sourceSaved?.numeric_id || !copy.numeric_id || sourceSaved.numeric_id === copy.numeric_id) throw new ToolError('COPY_NOT_INDEPENDENT', 'Independent numeric saved IDs could not be verified.');
  const sourceRecord = originalFingerprint ?? { source_fingerprint: sourceConfigurationFingerprint(source.panes), source_fingerprint_version: SOURCE_FINGERPRINT_VERSION };
  const copyRecord = { stage: 'created', request_hash: requestHash, source_layout_id: source.layout_id, copy_layout_id: copy.layout_id,
    ...sourceRecord, source_saved_baseline: sourceBaseline, tab_open_intent: sourceRecord.tab_open_intent === true || sourceRecord.clone_open_protocol !== DIRECT_CLONE_PROTOCOL };
  let savedVerification = unavailableSavedVerification();
  try {
    // Persist the independently observed identity before any fallible tab operation,
    // including recovery from a prior submission whose acknowledgement was lost.
    await ctx.checkpoint(key, copyRecord);
    savedVerification = await savedComparison(ctx, sourceSaved, copy, sourceBaseline);
    copyRecord.saved_configuration_verification = savedVerification;
    await ctx.checkpoint(key, copyRecord);
    const next = await findCopyContext(ctx, copy.layout_id, key, copyRecord);
    let destination;
    let verification;
    try {
      let lastSignature = null, equalReads = 0;
      destination = await ctx.poll(async () => {
        const snap = await page(next, 'snapshot');
        const signature = digest({ symbol: snap.symbol, resolution: snap.resolution, panes: snap.panes });
        equalReads = signature === lastSignature ? equalReads + 1 : 0;
        lastSignature = signature;
        return snap;
      }, snap => equalReads >= 2 && compareLayoutSnapshots(source, snap).chart_verified,
      { timeoutMs: 30000, intervalMs: 700, description: 'verify copied chart studies and parameters' });
      verification = compareLayoutSnapshots(source, destination);
    } catch (error) {
      try { destination = await page(next, 'snapshot'); verification = compareLayoutSnapshots(source, destination); }
      catch { verification = { chart_verified: false, full_fidelity_verified: false, mismatches: [], unverified_fields: ['destination chart state'], reason: error.code ?? 'READ_FAILED' }; }
    }
    const sourceStillMatches = sourceFingerprintMatch(sourceRecord, source.panes);
    if (sourceStillMatches !== true) {
      verification.chart_verified = false; verification.full_fidelity_verified = false;
      verification.unverified_fields.push(sourceFingerprintIssue(sourceRecord, sourceStillMatches));
    }
    const finalList = await page(next, 'list');
    const originalBefore = savedBefore.find(row => row.layout_id === source.layout_id);
    const originalAfter = finalList.find(row => row.layout_id === source.layout_id);
    const fields = row => row && { layout_id: row.layout_id, name: row.name, symbol: row.symbol, resolution: row.resolution };
    const sourceMetadataUnchanged = originalBefore ? canonical(fields(originalBefore)) === canonical(fields(originalAfter)) : null;
    // Saved copy content may become readable only after its chart has loaded.
    // Re-read both saved objects at the finish boundary; this also checks that
    // the source has not changed while the destination was opening.
    savedVerification = await savedComparison(ctx, sourceSaved, copy, sourceBaseline);
    const result = { created: true, independent_layout_verified: true, source_layout_id: source.layout_id,
      layout_id: copy.layout_id, name: copy.name, url: chartUrl(copy.layout_id),
      target_id: next.targetId, expected_layout_id: copy.layout_id,
      chart_verified: verification.chart_verified, verification, source_metadata_unchanged: sourceMetadataUnchanged,
      saved_configuration_verification: savedVerification,
      saved_drawings_inventory_verification: savedVerification.saved_drawings_inventory_verification,
      source_full_content_unchanged_verified: null,
      source_saved_layout_content_unchanged_verified: savedVerification.source_unchanged_since_baseline };
    await ctx.checkpoint(key, { ...copyRecord, stage: verification.chart_verified ? 'verified' : 'created_needs_verification', request_hash: requestHash,
      source_layout_id: source.layout_id, copy_layout_id: copy.layout_id, target_id: next.targetId,
      ...sourceRecord, source_saved_baseline: sourceBaseline, saved_configuration_verification: savedVerification,
      result: { ...result, verification: { ...verification, mismatches: verification.mismatches?.map(item => ({ field: item.field })) } } });
    return result;
  } catch (error) { throw copyReconciliationError(copy.layout_id, source.layout_id, error, savedVerification); }
}

export async function copyLayout(args, ctx) {
  const requestHash = digest({ name: args.name, source: ctx.expectedLayoutId, save_source: !!args.save_source });
  const key = `layout-copy-${digest(args.idempotency_key)}`;
  const prior = await ctx.loadCheckpoint(key);
  if (prior && prior.request_hash !== requestHash) throw new ToolError('IDEMPOTENCY_CONFLICT', 'This idempotency key belongs to another copy request.');
  if (prior?.copy_layout_id) {
    if (prior.copy_layout_id === prior.source_layout_id) throw new ToolError('COPY_NOT_INDEPENDENT', 'Recorded copy ID is identical to its source.');
    let savedVerification = unavailableSavedVerification();
    try {
      const listed = await page(ctx, 'list');
      const savedCopy = listed.find(row => row.layout_id === prior.copy_layout_id);
      const savedSource = listed.find(row => row.layout_id === prior.source_layout_id);
      if (!savedCopy) throw new ToolError('PREVIOUS_COPY_MISSING', 'The earlier copy no longer exists. Use a new operation key only if a new copy is intended.');
      if (!savedSource?.numeric_id || !savedCopy.numeric_id || savedSource.numeric_id === savedCopy.numeric_id) throw new ToolError('COPY_NOT_INDEPENDENT', 'Distinct source and destination saved numeric IDs could not be re-established.');
      savedVerification = await savedComparison(ctx, savedSource, savedCopy, prior.source_saved_baseline);
      // Old checkpoints did not record whether a tab-open was submitted. They
      // cannot authorize a second automatic open after an uncertain outcome.
      const copyRecord = { ...prior, tab_open_intent: typeof prior.tab_open_intent === 'boolean' ? prior.tab_open_intent : true,
        saved_configuration_verification: savedVerification };
      await ctx.checkpoint(key, copyRecord);
      const next = await findCopyContext(ctx, prior.copy_layout_id, key, copyRecord);
      const sourceCtx = await findLayoutContext(ctx, prior.source_layout_id, { open: false, preferredTargetId: ctx.targetId });
      const currentSource = await page(sourceCtx, 'snapshot');
      const currentDestination = await page(next, 'snapshot');
      const verification = compareLayoutSnapshots(currentSource, currentDestination);
      const sourceStillMatches = sourceFingerprintMatch(prior, currentSource.panes);
      if (sourceStillMatches !== true) {
        verification.chart_verified = false;
        verification.full_fidelity_verified = false;
        verification.unverified_fields.push(sourceFingerprintIssue(prior, sourceStillMatches));
      }
      savedVerification = await savedComparison(ctx, savedSource, savedCopy, prior.source_saved_baseline);
      const result = { created: true, independent_layout_verified: true, source_layout_id: prior.source_layout_id,
        layout_id: prior.copy_layout_id, name: savedCopy.name, url: chartUrl(prior.copy_layout_id),
        replayed: true, chart_verified: verification.chart_verified, verification,
        verification_scope: 'Current source and destination comparison; no additional clone submitted.',
        target_id: next.targetId, expected_layout_id: prior.copy_layout_id,
        saved_configuration_verification: savedVerification,
        saved_drawings_inventory_verification: savedVerification.saved_drawings_inventory_verification,
        source_full_content_unchanged_verified: null,
        source_saved_layout_content_unchanged_verified: savedVerification.source_unchanged_since_baseline };
      await ctx.checkpoint(key, { ...copyRecord, stage: verification.chart_verified ? 'verified' : 'created_needs_verification',
        target_id: next.targetId, saved_configuration_verification: savedVerification,
        result: { ...result, verification: { ...verification, mismatches: verification.mismatches.map(item => ({ field: item.field })) } } });
      return result;
    } catch (error) {
      if (['PREVIOUS_COPY_MISSING', 'COPY_NOT_INDEPENDENT'].includes(error.code)) throw error;
      throw copyReconciliationError(prior.copy_layout_id, prior.source_layout_id, error, savedVerification);
    }
  }
  let source = await page(ctx, 'snapshot');
  if (!source.layout_id || source.layout_id !== ctx.expectedLayoutId) throw new ToolError('LAYOUT_MISMATCH', 'Source layout identity could not be verified.');
  if (source.unsaved_changes) {
    if (!args.save_source) throw new ToolError('UNSAVED_SOURCE', 'Save the desired source configuration first, or explicitly set save_source=true. Native copy may copy the saved version.');
    const result = await saveLayout({}, ctx);
    if (!result.saved) throw new ToolError('SOURCE_SAVE_UNVERIFIED', 'Source save could not be verified. No copy was submitted.');
    source = await page(ctx, 'snapshot');
  }
  const savedBefore = await page(ctx, 'list');
  if (!savedBefore.find(row => row.layout_id === source.layout_id)?.numeric_id) throw new ToolError('SOURCE_SAVED_ID_UNAVAILABLE', 'The exact source must be present in the saved-layout list with a stable numeric ID before copying.');
  if (prior?.stage === 'submitted') {
    const matches = savedBefore.filter(row => row.name === args.name && !prior.known_ids.includes(row.numeric_id) && (!prior.submitted_copy_layout_id || row.layout_id === prior.submitted_copy_layout_id));
    if (matches.length === 1) return completeCopy(ctx, source, matches[0], savedBefore, key, requestHash, prior.source_saved_baseline,
      { source_fingerprint: prior.source_fingerprint, source_fingerprint_version: prior.source_fingerprint_version, clone_open_protocol: prior.clone_open_protocol, tab_open_intent: prior.tab_open_intent });
    throw new ToolError('UNCERTAIN_MUTATION', 'An earlier clone was submitted; it will not be submitted again automatically. Reconcile the saved-layout list.', { idempotency_key: args.idempotency_key, matches: matches.map(row => row.layout_id) });
  }
  if (savedBefore.some(row => row.name === args.name)) throw new ToolError('DUPLICATE_LAYOUT_NAME', 'A saved layout already has this name. Choose a unique destination name.');
  const knownIds = savedBefore.map(row => row.numeric_id);
  const sourceBaseline = await savedFingerprint(ctx, savedBefore.find(row => row.layout_id === source.layout_id));
  const desktopDirect = typeof ctx.browser.isDesktop === 'function' && await ctx.browser.isDesktop() === true;
  const cloneOpenProtocol = desktopDirect ? DIRECT_CLONE_PROTOCOL : 'native-controller-autoopen-or-unknown-v1';
  await ctx.assertLayout(source.layout_id);
  await ctx.checkpoint(key, { stage: 'submitted', request_hash: requestHash, known_ids: knownIds, source_layout_id: source.layout_id, source_fingerprint: sourceConfigurationFingerprint(source.panes), source_fingerprint_version: SOURCE_FINGERPRINT_VERSION, source_saved_baseline: sourceBaseline, clone_open_protocol: cloneOpenProtocol });
  let submitError = null, submittedCopyId = null;
  try {
    const submission = await page(ctx, 'copy', { name: args.name, ...(desktopDirect ? { desktop_direct: true, source_layout_id: source.layout_id } : {}) });
    if (desktopDirect && typeof submission?.copy_layout_id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(submission.copy_layout_id) && submission.copy_layout_id !== source.layout_id) {
      submittedCopyId = submission.copy_layout_id;
      await ctx.checkpoint(key, { stage: 'submitted', request_hash: requestHash, known_ids: knownIds, source_layout_id: source.layout_id,
        source_fingerprint: sourceConfigurationFingerprint(source.panes), source_fingerprint_version: SOURCE_FINGERPRINT_VERSION,
        source_saved_baseline: sourceBaseline, submitted_copy_layout_id: submittedCopyId, clone_open_protocol: cloneOpenProtocol });
    }
  } catch (error) { submitError = error.code ?? 'BROWSER_CONTEXT_CHANGED'; }
  let copy;
  try {
    const matches = await ctx.poll(async () => {
      try { return (await page(ctx, 'list')).filter(row => !knownIds.includes(row.numeric_id) && row.name === args.name && (!submittedCopyId || row.layout_id === submittedCopyId)); }
      catch { return []; }
    }, rows => rows.length > 0, { timeoutMs: args.timeout_ms ?? 120000, intervalMs: 700, description: 'confirm a new saved layout ID' });
    if (matches.length !== 1) throw new ToolError('AMBIGUOUS_COPY', 'Multiple new layouts have the requested name. No destination was selected.', { layout_ids: matches.map(row => row.layout_id) });
    copy = matches[0];
  } catch (error) {
    throw new ToolError('UNCERTAIN_MUTATION', 'The clone submission could not be reconciled. Do not repeat it with a different key before inspecting saved layouts.', { submission_error: submitError, verification_error: error.code ?? 'TIMEOUT', operation_key: args.idempotency_key });
  }
  await ctx.checkpoint(key, { stage: 'created', request_hash: requestHash, source_layout_id: source.layout_id, copy_layout_id: copy.layout_id, known_ids: knownIds, source_fingerprint: sourceConfigurationFingerprint(source.panes), source_fingerprint_version: SOURCE_FINGERPRINT_VERSION, source_saved_baseline: sourceBaseline,
    clone_open_protocol: cloneOpenProtocol, tab_open_intent: cloneOpenProtocol !== DIRECT_CLONE_PROTOCOL });
  return completeCopy(ctx, source, copy, savedBefore, key, requestHash, sourceBaseline,
    { source_fingerprint: sourceConfigurationFingerprint(source.panes), source_fingerprint_version: SOURCE_FINGERPRINT_VERSION, clone_open_protocol: cloneOpenProtocol });
}

const tools = [
  { name: 'layout_list', description: 'List saved layouts with stable IDs, symbols, resolutions and modification times.', inputSchema: schema({ filter: text }), mutates: false, requiresLayout: false,
    handler: async (args, ctx) => { const all = await page(ctx, 'list'); return { layouts: args.filter ? all.filter(row => row.name?.toLowerCase().includes(args.filter.toLowerCase())) : all }; } },
  { name: 'layout_get', description: 'Read the actual widget layout ID, name, dirty state, symbol and resolution.', inputSchema: schema(), mutates: false,
    handler: (_args, ctx) => page(ctx, 'get') },
  { name: 'layout_snapshot', description: 'Export a bounded chart configuration snapshot. Reports properties and drawings that could not be captured; never claims complete restoration.', inputSchema: schema({ name: text }, ['name']), mutates: false,
    handler: async (args, ctx) => { const snapshot = await page(ctx, 'snapshot'); const file = await ctx.exportJson(`layout-${args.name}`, snapshot); return { snapshot, file }; } },
  { name: 'layout_save', description: 'Save the current layout in place, optionally renaming it. This is not a duplicate operation.', inputSchema: schema({ name: text }), mutates: true, handler: saveLayout },
  { name: 'layout_copy', description: 'Native Make a copy with a unique name, new saved-ID verification, chart comparison and a durable idempotency key. Returns the destination browser target for subsequent operations.',
    inputSchema: schema({ name: text, idempotency_key: keySchema, save_source: { type: 'boolean', default: false }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 180000, default: 120000 } }, ['name', 'idempotency_key']), mutates: true, handler: copyLayout },
  { name: 'layout_open', description: 'Open or reuse a tab for an exact saved TradingView layout ID and verify the widget loaded that ID.', inputSchema: schema({ layout_id: layoutId }, ['layout_id']), mutates: true,
    handler: async (args, ctx) => { const next = await findLayoutContext(ctx, args.layout_id); return { ...(await page(next, 'get')), target_id: next.targetId, expected_layout_id: args.layout_id }; } },
  { name: 'layout_create', description: 'Create a blank saved layout, open it in a browser tab and save its name only after verifying the new widget ID.', inputSchema: schema({ name: text, idempotency_key: keySchema }, ['name', 'idempotency_key']), mutates: true,
    handler: async (args, ctx) => {
      const key = `layout-create-${digest(args.idempotency_key)}`;
      const requestHash = digest({ name: args.name, source: ctx.expectedLayoutId });
      const prior = await ctx.loadCheckpoint(key);
      if (prior && prior.request_hash !== requestHash) throw new ToolError('IDEMPOTENCY_CONFLICT', 'Key belongs to a different new-layout request.');
      if (prior?.layout_id) {
        const next = await findLayoutContext(ctx, prior.layout_id);
        if (prior.stage !== 'saved') {
          const saved = await saveLayout({ name: args.name }, next);
          await ctx.checkpoint(key, { ...prior, stage: 'saved' });
          return { ...saved, created: true, target_id: next.targetId, expected_layout_id: prior.layout_id, replayed: true };
        }
        const current = await page(next, 'get');
        return { ...current, created: true, requested_name_verified: current.name === args.name,
          target_id: next.targetId, expected_layout_id: prior.layout_id, replayed: true };
      }
      if (prior) throw new ToolError('UNCERTAIN_MUTATION', 'A creation was previously submitted without a confirmed ID. Inspect saved layouts before creating again.');
      const current = await page(ctx, 'get');
      if (current.unsaved_changes) throw new ToolError('UNSAVED_SOURCE', 'Save the current chart before creating a new layout.');
      if ((await page(ctx, 'list')).some(row => row.name === args.name)) throw new ToolError('DUPLICATE_LAYOUT_NAME', 'Layout name already exists.');
      await ctx.assertLayout(ctx.expectedLayoutId);
      await ctx.checkpoint(key, { stage: 'submitted', request_hash: requestHash });
      const made = await page(ctx, 'create');
      if (made.layout_id === current.layout_id) throw new ToolError('COPY_NOT_INDEPENDENT', 'New-layout API reused the current layout ID.');
      await ctx.checkpoint(key, { stage: 'created', request_hash: requestHash, layout_id: made.layout_id });
      const next = await findLayoutContext(ctx, made.layout_id);
      const saved = await saveLayout({ name: args.name }, next);
      await ctx.checkpoint(key, { stage: 'saved', request_hash: requestHash, layout_id: made.layout_id });
      return { ...saved, created: saved.saved, target_id: next.targetId, expected_layout_id: made.layout_id };
    } },
  { name: 'layout_rename', description: 'Rename the exact current saved layout and confirm the same ID has the new name.', inputSchema: schema({ name: text }, ['name']), mutates: true,
    handler: async (args, ctx) => {
      const before = await page(ctx, 'get');
      if (before.read_only) throw new ToolError('READ_ONLY_LAYOUT', 'A shared read-only chart must be copied first.');
      if ((await page(ctx, 'list')).some(row => row.name === args.name && row.layout_id !== before.layout_id)) throw new ToolError('DUPLICATE_LAYOUT_NAME', 'Another saved layout already has that name.');
      await ctx.assertLayout(ctx.expectedLayoutId); await page(ctx, 'rename', { name: args.name });
      const after = await ctx.poll(() => page(ctx, 'list'), rows => rows.some(row => row.layout_id === before.layout_id && row.name === args.name), { timeoutMs: 20000, description: 'verify renamed layout' });
      return { renamed: true, previous_name: before.name, layout: after.find(row => row.layout_id === before.layout_id) };
    } },
  { name: 'layout_delete', description: 'Delete one saved layout by exact ID and verify it disappeared. Refuses the layout currently bound to this tool.', inputSchema: schema({ layout_id: layoutId }, ['layout_id']), mutates: true, destructive: true,
    handler: async (args, ctx) => {
      const before = await page(ctx, 'list'); const hit = before.find(row => row.layout_id === args.layout_id);
      if (!hit) throw new ToolError('NOT_FOUND', 'No saved layout has this ID.');
      if (args.layout_id === ctx.expectedLayoutId) throw new ToolError('CURRENT_LAYOUT_PROTECTED', 'Bind a different chart before deleting this layout.');
      await ctx.assertLayout(ctx.expectedLayoutId); await page(ctx, 'delete', { layout_id: args.layout_id });
      await ctx.poll(() => page(ctx, 'list'), rows => !rows.some(row => row.layout_id === args.layout_id), { timeoutMs: 20000, description: 'verify layout deletion' });
      return { deleted: hit, verified_absent: true };
    } },
];

export default tools;
