/* ══════════════════════════════════════════════════════════════
   LIBRARY ASSET → PLATFORM PROMPT TRANSLATOR
══════════════════════════════════════════════════════════════ */

function buildAssetBlock(asset, platform, shotType) {
  if (!asset) return '';
  // Shallow-clone with a frame/shot-filtered description so every branch
  // below (character/location/era/prop/style) gets the trimmed text for
  // free, without touching each branch individually. See
  // filterDescByShotType() (01-core.js) for why this exists — raw
  // a.description can be a stack of merged [Close-up]/[Mid Shot]/
  // [Character Sheet]/etc blocks, and without this filter every block
  // printed in every panel's prompt regardless of that panel's actual
  // shotType (live-test bug found 2026-06-30, fixed by callers passing
  // their panel's shotType through here). shotType is optional — when
  // omitted (e.g. some older/other call sites not yet updated), this is
  // a no-op and behavior is unchanged from before this fix.
  const a = (shotType && typeof filterDescByShotType === 'function')
    ? { ...asset, description: filterDescByShotType(asset.description, shotType) }
    : asset;

  // Helper: only add a sub-field value if it's not already contained in description
  function addIfNew(base, extra) {
    if (!extra) return '';
    const b = base.toLowerCase();
    const e = extra.toLowerCase().slice(0, 40); // check first 40 chars for overlap
    return b.includes(e) ? '' : extra;
  }

  if (a.type === 'character') {
    const parts = [a.description];
    // Materiality nudge on costume too — skill's own example is costume
    // ("not just tunic but rough-spun linen, faded olive, frayed collar").
    // Same guard: only fires on thin/bare costume text, never overwrites.
    const rawCostume = a.costume;
    const costume = addIfNew(a.description, typeof materialityNudge === 'function'
      ? materialityNudge(rawCostume || '', 'with visible fabric weave, wear state, and finish')
      : rawCostume);
    const emotional = addIfNew(a.description, a.emotional);
    const era = addIfNew(a.description, a.era);
    const role = addIfNew(a.description, a.role);
    if (costume) parts.push('Costume and appearance: ' + costume);
    if (emotional) parts.push('Emotional range: ' + emotional);
    if (era) parts.push('Period: ' + era);
    if (role) parts.push('Role: ' + role);

    if (platform === 'nb') {
      return `${a.name} (${a.role || 'character'}): ${parts.join('. ')}.`;
    }
    if (platform === 'gpt') {
      return `${a.name.toUpperCase()} — ${parts.join('. ')}. Preserve ${a.name}'s identity, face, and proportions exactly across all panels.`;
    }
    if (platform === 'mj') {
      return [a.name, a.description, costume, era].filter(Boolean).join(', ');
    }
  }

  if (a.type === 'location') {
    const parts = [a.description];
    const period = addIfNew(a.description, a.period);
    const atmosphere = addIfNew(a.description, a.atmosphere);
    const keyDetails = addIfNew(a.description, a.keyDetails);
    if (period) parts.push(period);
    if (atmosphere) parts.push(atmosphere);
    if (keyDetails) parts.push(keyDetails);

    if (platform === 'nb') {
      return `Setting — ${a.name}: ${parts.join('. ')}.`;
    }
    if (platform === 'gpt') {
      return `${a.name.toUpperCase()}: ${parts.join('. ')}.`;
    }
    if (platform === 'mj') {
      return parts.join(', ');
    }
  }

  if (a.type === 'era') {
    const parts = [a.description];
    const region = addIfNew(a.description, a.region);
    const cultural = addIfNew(a.description, a.cultural);
    const palette = addIfNew(a.description, a.palette);
    if (region) parts.push(region);
    if (cultural) parts.push(cultural);
    if (palette) parts.push('Colour palette: ' + palette);

    if (platform === 'nb') {
      return `Period and cultural context — ${a.name}: ${parts.join('. ')}.`;
    }
    if (platform === 'gpt') {
      return `ERA/PERIOD: ${a.name}. ${parts.join('. ')}.`;
    }
    if (platform === 'mj') {
      return [a.name, a.description, palette].filter(Boolean).join(', ');
    }
  }

  if (a.type === 'prop') {
    // Materiality nudge (storyboard-director skill hard rule: every prop
    // needs material/finish/wear-state, not just a bare noun) — only fires
    // when the user's own material field is thin/missing; never overwrites
    // a rich user-authored description. materialityNudge() lives in
    // 06-scene-engine.js, guarded here since translator can load first.
    const rawMaterial = a.material;
    const material = addIfNew(a.description, typeof materialityNudge === 'function'
      ? materialityNudge(rawMaterial || '', 'visible material, finish, and wear state')
      : rawMaterial);
    const condition = addIfNew(a.description, a.condition);
    const significance = addIfNew(a.description, a.significance);
    const parts = [a.description];
    if (material) parts.push('Material: ' + material);
    if (condition) parts.push('Condition: ' + condition);
    if (significance) parts.push(significance);

    if (platform === 'nb') {
      return `${a.name}: ${parts.join('. ')}.`;
    }
    if (platform === 'gpt') {
      return `${a.name.toUpperCase()}: ${parts.join('. ')}.`;
    }
    if (platform === 'mj') {
      return [a.name, a.description, material, condition].filter(Boolean).join(', ');
    }
  }

  if (a.type === 'style') {
    const parts = [a.description];
    const movement = addIfNew(a.description, a.movement);
    const render = addIfNew(a.description, a.render);
    const grading = addIfNew(a.description, a.grading);
    if (movement) parts.push(movement);
    if (render) parts.push(render);
    if (grading) parts.push(grading);
    return parts.filter(Boolean).join(', ');
  }

  return a.description || '';
}

function buildNegativesFromMentions(mentions, platform) {
  const negatives = [];
  mentions.forEach(({ asset: a }) => {
    if (a.type === 'era' && a.negatives) {
      negatives.push(...a.negatives.split(',').map(s => s.trim()).filter(Boolean));
    }
  });
  if (!negatives.length) return '';
  if (platform === 'mj') return '--no ' + negatives.join(', ');
  if (platform === 'nb') return 'Do not include: ' + negatives.join('. Do not include ') + '.';
  if (platform === 'gpt') return negatives.map(n => 'No ' + n.replace(/^no /i, '')).join('. ') + '.';
  return '';
}

