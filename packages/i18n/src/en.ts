/** English is the reference dictionary: its keys define the required set. */
export const en = {
  stampTooSoon: 'This card was already stamped today. Try again tomorrow.',
  stampsRemaining: '{count} stamps remaining',
  rewardEarned: 'Reward earned',
  cardNotFound: 'That card could not be found.',
  cardExpired: 'This card has expired.',
  serverError: 'Something went wrong. Please try again.',
  stampSuccess: 'Stamped — {stamps}/{goal}',
  passNotFound: 'We could not find a card for that code.',
  stampInputRequired: 'Enter a serial number or short code.',
} as const;
