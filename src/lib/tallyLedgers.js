// The ledgers file: creates, in Tally, the ledgers the vouchers post to that are not there yet, so it is imported BEFORE the vouchers file.
// Built from tally_ledgers (the owner's list of his Tally's ledgers and what is still to be created), nothing typed. Modelled on the keys
// Tally itself writes for vouchers (the accountant's DayBook.json); the master shape (`metadata.type` "Ledger", `parent` = the group,
// `isbillwiseon`) is Tally's own pattern but has not been imported on a real Tally yet: try it on a copy company with the test vouchers.
//
// Renames are NOT in the file: changing the name of a ledger that already carries a year of vouchers is done by the accountant in Tally
// (Alter Ledger), because an import cannot be trusted to rename rather than create a second ledger.
//
//   Sundry Debtors named "...(order control)"   bill by bill, Unregistered/Consumer (the customer ledgers every order's bill lives in)
//   everything else                             just the name and the group
import { guid } from './tallyJson.js';

const billwise = (l) => /\(order control\)$/i.test(l.name) || /^COD receivable/i.test(l.name);

/** tally_ledgers rows → { file: { tallymessage }, create: [...], rename: [...] }. Only will_create rows go in the file. */
export function buildLedgersFile(ledgers) {
  const create = ledgers.filter(l => l.status === 'will_create').sort((a, b) => a.name.localeCompare(b.name));
  const rename = ledgers.filter(l => l.status === 'will_rename').sort((a, b) => a.name.localeCompare(b.name));
  const tallymessage = create.map(l => {
    const o = {
      metadata: { type: 'Ledger', name: l.name, action: 'Create', remoteid: guid(`erp-ledger|${l.name}`) },
      name: l.name, parent: l.under,
    };
    if (billwise(l)) o.isbillwiseon = true;
    if (l.under === 'Sundry Debtors' && /\(order control\)$/i.test(l.name)) o.gstregistrationtype = 'Unregistered/Consumer';
    return o;
  });
  return { file: { tallymessage }, create, rename };
}

export const ledgersFileName = () => 'Tally-ledgers-to-create.json';

/**
 * One file for the whole import: the ledgers still missing in Tally come FIRST, then the vouchers, so a single import creates the ledgers and then posts
 * into them (Tally reads the messages in order). `ledgers` are the tally_ledgers rows; `file` is buildTallyFile's. The renames are not in it and must
 * already be done in Tally, because the vouchers use the new names.
 */
export function withLedgers(file, ledgers) {
  const first = buildLedgersFile(ledgers || []).file.tallymessage;
  return { tallymessage: [...first, ...file.tallymessage] };
}
