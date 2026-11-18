// The ledgers file: creates, in Tally, the ledgers the vouchers post to that are not there yet, so it is imported BEFORE the vouchers file.
// Built from tally_ledgers (the owner's list of his Tally's ledgers and what is still to be created), nothing typed. Modelled on the keys
// Tally itself writes for vouchers (the accountant's DayBook.json); the master shape (`metadata.type` "Ledger", `parent` = the group,
// `isbillwiseon`) is Tally's own pattern but has not been imported on a real Tally yet: try it on a copy company with the test vouchers.
//
// Renames are NOT in the file: changing the name of a ledger that already carries a year of vouchers is done by the accountant in Tally
// (Alter Ledger), because an import cannot be trusted to rename rather than create a second ledger.
//
//   Sundry Debtors named "...(order control)"   bill by bill, Unregistered/Consumer (the customer ledgers every order's bill lives in)
//   a supplier's own ledger (vendors.tally_ledger_name)   the owner's rule (18 Nov 2026): never a bare name. Bill by bill, GST registration type, GSTIN, PAN, state,
//                                                country, mailing name, address, pincode. The accountant's files hold NO ledger master export (only vouchers and the
//                                                trial balance), so the master's key names cannot be read from them. What his Day Book proves is what Tally keeps on a
//                                                party (mailing name, address lines, pincode, state, country, GSTIN, PAN, registration type) and how it writes a list of
//                                                strings (`address: [{ metadata: true, type: 'String' }, line, ...]`); the master keys (LEDMAILINGDETAILS, LEDGSTREGDETAILS,
//                                                LEDSTATENAME, INCOMETAXNUMBER) are Tally's TDL names, to be confirmed by importing the test file into a copy company.
//   everything else                             just the name and the group
import { guid } from './tallyJson.js';
import { stateOfGstin, stateByCode } from './gstStates.js';

const billwise = (l) => /\(order control\)$/i.test(l.name) || /^COD receivable/i.test(l.name);

/** tally_ledgers rows → { file: { tallymessage }, create: [...], rename: [...] }. Only will_create rows go in the file. */
export function buildLedgersFile(ledgers, vendors = []) {
  const vendorOf = new Map((vendors || []).filter(v => v.tally_ledger_name).map(v => [v.tally_ledger_name, v]));
  const create = ledgers.filter(l => l.status === 'will_create').sort((a, b) => a.name.localeCompare(b.name));
  const rename = ledgers.filter(l => l.status === 'will_rename').sort((a, b) => a.name.localeCompare(b.name));
  const tallymessage = create.map(l => {
    const o = {
      metadata: { type: 'Ledger', name: l.name, action: 'Create', remoteid: guid(`erp-ledger|${l.name}`) },
      name: l.name, parent: l.under,
    };
    if (billwise(l)) o.isbillwiseon = true;
    if (l.under === 'Sundry Debtors' && /\(order control\)$/i.test(l.name)) o.gstregistrationtype = 'Unregistered/Consumer';
    const v = vendorOf.get(l.name);
    if (v) Object.assign(o, partyDetails(v));
    return o;
  });
  return { file: { tallymessage }, create, rename };
}

/** The details of a supplier's own ledger, from the supplier record. A GSTIN gives the state and the PAN; without one the supplier is unregistered. */
export function partyDetails(v) {
  const gstin = String(v.gstin ?? '').toUpperCase();
  const state = stateOfGstin(gstin) || stateByCode(v.state_code);
  const pan = v.pan || (gstin.length === 15 ? gstin.slice(2, 12) : '');
  const reg = gstin ? 'Regular' : 'Unregistered/Consumer';
  const addr = String(v.address ?? '').split('\n').map(x => x.trim()).filter(Boolean);
  return {
    isbillwiseon: true, gstregistrationtype: reg, ...(gstin ? { partygstin: gstin } : {}), ...(pan ? { incometaxnumber: pan } : {}), ...(state ? { ledstatename: state } : {}), countryofresidence: 'India',
    ledmailingdetails: [{ applicablefrom: '20260401', ...(addr.length ? { address: [{ metadata: true, type: 'String' }, ...addr] } : {}), mailingname: v.name, ...(state ? { state } : {}), country: 'India', ...(v.pincode ? { pincode: String(v.pincode) } : {}) }],
    ledgstregdetails: [{ applicablefrom: '20260401', gstregistrationtype: reg, ...(state ? { placeofsupply: state } : {}), ...(gstin ? { gstin } : {}) }],
  };
}

export const ledgersFileName = () => 'Tally-ledgers-to-create.json';

/**
 * One file for the whole import: the ledgers still missing in Tally come FIRST, then the vouchers, so a single import creates the ledgers and then posts
 * into them (Tally reads the messages in order). `ledgers` are the tally_ledgers rows; `file` is buildTallyFile's. The renames are not in it and must
 * already be done in Tally, because the vouchers use the new names.
 */
export function withLedgers(file, ledgers, vendors = []) {
  const first = buildLedgersFile(ledgers || [], vendors).file.tallymessage;
  return { tallymessage: [...first, ...file.tallymessage] };
}
