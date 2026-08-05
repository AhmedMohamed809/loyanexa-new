# Template photography — sources and licence

The photographs in `apps/demo/assets/templates/` ship with the card templates (BUILD.md §8.4)
and are redistributed in this **public** repository.

## Licence

Every image comes from **Unsplash** or **Pexels**. Both licences grant free use, including
commercially, without permission or attribution, and both permit redistribution as part of a
larger work — which is what this is.

- Unsplash Licence — <https://unsplash.com/license>
- Pexels Licence — <https://www.pexels.com/license/>

Attribution is therefore **not required**. This file exists anyway, because "where did this
file come from?" becomes unanswerable surprisingly quickly, and an unanswerable licence
question is the kind that eventually gets settled by deleting the file.

## What is not allowed, by either licence

Worth stating, because a loyalty platform is exactly the product that might drift into it:

- Selling the photographs themselves, unmodified — as wallpapers, as a stock pack, as an
  asset library. They are here as *card backgrounds*, not as inventory.
- Implying the photographers or the platforms endorse LoyaNexa.
- Using images of identifiable people in a way that suggests they endorse a merchant. This is
  why the people in these photographs are shot from behind, in profile, or mid-task rather
  than posed to camera.

## The set

Three per trade, 24 in total.

| Trade | Files | Subject |
|---|---|---|
| Café | `cafe-1..3` | latte service · roasted beans · iced drink |
| Bakery | `bakery-1..3` | artisan loaves · cupcakes · croissant |
| Restaurant | `restaurant-1..3` | dining room · plated dish · casual interior |
| Barber | `barber-1..3` | hot shave · shop interior · children's cut |
| Salon | `salon-1..3` | treatment room · hair wash · make-up |
| Gym | `gym-1..3` | free weights · floor class · barbell |
| Car wash | `carwash-1..3` | spray wash · steam wash · hand foam |
| Shop | `shop-1..3` | clothing rail · open sign · footwear |

`carwash-2` and `salon-2` are from Pexels; the rest are from Unsplash.

## How they are processed

Nothing is served from `assets/`. Each file goes through the same
`normalizeUpload('cover')` pipeline a merchant's own upload uses — decoded, resized to the
strip's 1125×432, re-encoded and content-addressed — so by the time a template is applied,
its cover is an ordinary `CardImage` row with no special handling anywhere downstream. See
`apps/demo/templateAssets.ts`.

They render at **0.28 opacity** behind the stamps by default. That is deliberately low: the
photograph exists to make the card feel like it belongs to the business, but the stamps are
the only thing on the card a customer has to be able to read, and a photograph at full
strength makes a half-filled row genuinely hard to count. The designer lets a merchant raise
it.

## Replacing one

Drop a new `.jpg` into `apps/demo/assets/templates/` under the same stem and restart. There
is nothing else to update: the filename stem is what `cardTemplates.ts` references, and the
hash is derived from the file's contents. Update the table above and the licence note if the
source changes.
