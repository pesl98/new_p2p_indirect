/**
 * Portal errors follow the page language. Dutch is the default.
 * Accept-Language "en" selects English. Unknown codes keep the thrown text.
 */

const MESSAGES = {
  nl: {
    portal_link_invalid: 'Deze link is ongeldig of verlopen. Neem contact op met de inkoper.',
    rate_limited: 'Te veel verzoeken. Probeer het zo meteen opnieuw.',
    sourcing_disabled: 'Offerteaanvragen staan uit op deze omgeving.',
    portal_not_configured: 'Portallinks zijn niet geconfigureerd.',
    event_cancelled: 'Deze offerteaanvraag is geannuleerd.',
    invitation_declined: 'U hebt afgezien van deelname.',
    deadline_passed: 'De inschrijftermijn is gesloten om {deadline}.',
    submission_id_required: 'submission_id moet een UUID zijn.',
    bid_lines_required: 'Elke regel heeft een prijs of "niet aangeboden".',
    invalid_amount: 'Een aangeboden regel heeft een stukprijs in centen nodig.',
    invalid_lead_time: 'De levertijd moet tussen 0 en 730 dagen liggen.',
    text_too_long: 'De tekst is te lang.',
    invalid_deadline: 'De geldigheidsdatum moet JJJJ-MM-DD zijn.',
    bid_not_submitted: 'Er is geen ingediende offerte om in te trekken.',
    not_a_pdf: 'Het bestand is geen PDF.',
    too_many_files: 'Een offerte heeft maximaal {max} bijlagen.',
    event_files_too_large: 'De bijlagen van de offerte zijn samen groter dan 40 MB.',
    file_not_found: 'Het bestand is niet gevonden.',
    qa_closed: 'Vragen zijn niet open op deze offerteaanvraag.',
    question_required: 'Een vraag is verplicht.',
    busy: 'De database is bezet. Probeer het zo meteen opnieuw.',
    payload_too_large: 'De offerte is te groot.',
    portal_error: 'Portal request failed',
    sourcing_error: 'De PDF kon niet worden opgeslagen.'
  },
  en: {
    portal_link_invalid: 'This link is invalid or has expired. Contact the buyer.',
    rate_limited: 'Too many requests. Try again shortly.',
    sourcing_disabled: 'Requests for quotation are turned off in this environment.',
    portal_not_configured: 'Portal links are not configured.',
    event_cancelled: 'This request for quotation has been cancelled.',
    invitation_declined: 'You have declined this invitation.',
    deadline_passed: 'The bidding deadline closed at {deadline}.',
    submission_id_required: 'submission_id must be a UUID.',
    bid_lines_required: 'Each line needs a price or "not offered".',
    invalid_amount: 'An offered line needs a unit price in cents.',
    invalid_lead_time: 'Lead time must be between 0 and 730 days.',
    text_too_long: 'The text is too long.',
    invalid_deadline: 'The validity date must be YYYY-MM-DD.',
    bid_not_submitted: 'There is no submitted bid to withdraw.',
    not_a_pdf: 'The file is not a PDF.',
    too_many_files: 'A bid can have at most {max} attachments.',
    event_files_too_large: 'The bid attachments together exceed 40 MB.',
    file_not_found: 'The file was not found.',
    qa_closed: 'Questions are not open on this request for quotation.',
    question_required: 'A question is required.',
    busy: 'The database is busy. Try again shortly.',
    payload_too_large: 'The bid is too large.',
    portal_error: 'Portal request failed',
    sourcing_error: 'The PDF could not be stored.'
  }
};

export function portalLanguage(req) {
  const header = String(req?.headers?.['accept-language'] || '');
  const first = header.split(',')[0]?.trim().toLowerCase() || '';
  if (first.startsWith('en')) return 'en';
  return 'nl';
}

function fill(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (
    params && params[key] != null ? String(params[key]) : ''
  ));
}

export function portalMessage(lang, code, params, fallback) {
  const catalog = MESSAGES[lang] || MESSAGES.nl;
  const template = catalog[code];
  if (!template) return fallback;
  return fill(template, params);
}
