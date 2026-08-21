/**
 * `'name' in box` names one key, and the returned object owes the same answer
 * a const object does: the probed key is used, and every other member still
 * has to answer for itself.
 */
function makeBox() {
  return {
    lid: 'tin',
    label: 'Weeknights',
    deadLining: 'felt',
  };
}

export function described(): string {
  const box = makeBox();
  return 'lid' in box ? box.label : 'unlidded';
}
