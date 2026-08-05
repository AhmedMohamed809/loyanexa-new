// apps/demo/views/legal.ts — the privacy policy and terms of service.
//
// BUILD.md §15 Phase 7 lists these as required before the first paying
// merchant, and it is right: this product stores customer names, phone
// numbers, email addresses and birthdays, which is personal data under the
// UK GDPR whether or not anyone has written a policy about it.
//
// ─────────────────────────────────────────────────────────────────────────
// THESE ARE DRAFTS. A SOLICITOR SHOULD READ THEM BEFORE A PAYING MERCHANT
// DOES. They are written to be accurate about what the code actually does —
// which is the part a lawyer cannot check and an engineer can — but "accurate"
// and "legally sufficient for the jurisdictions you sell into" are different
// standards, and only one of them is met here.
// ─────────────────────────────────────────────────────────────────────────
//
// Long-form prose lives here as documents rather than in the i18n
// dictionaries. A privacy policy is not UI copy: it is versioned, it is
// quoted, its paragraphs are referred to by number, and a translation of it
// has to say the same thing in both languages rather than merely fit the same
// slot. Keeping the two versions side by side in one file is what makes that
// checkable.

import { type Lang } from '../../../packages/i18n/src/index.ts';
import { escapeHtml } from './html.ts';
import { CHROME_CSS } from './chrome.ts';

/** The date the current text took effect. Update it whenever the wording changes materially — people are entitled to know which version they agreed to. */
export const LEGAL_EFFECTIVE_DATE = '5 August 2026';
export const LEGAL_EFFECTIVE_DATE_AR = '٥ أغسطس ٢٠٢٦';

/** Where a data-protection request should go. */
export const PRIVACY_CONTACT = 'ahmedabdulalgane@gmail.com';

interface Section {
  h: string;
  body: string[];
}

function renderDoc(lang: Lang, title: string, effective: string, sections: Section[]): string {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const body = sections
    .map(
      (s, i) => `<section class="legal-s">
      <h2>${i + 1}. ${escapeHtml(s.h)}</h2>
      ${s.body.map((p) => `<p>${p}</p>`).join('\n      ')}
    </section>`
    )
    .join('\n    ');

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · LoyaNexa</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@300;400;500;600;700&display=swap">
<style>
${CHROME_CSS}
  /* A legal document is read, not scanned. A narrower measure and a taller
     line-height than the dashboard uses, because the failure mode here is
     someone giving up halfway rather than someone not finding a button. */
  .legal { max-width: 46rem; margin: 0 auto; padding: 40px 22px 80px; }
  .legal h1 { font-size: 30px; margin: 0 0 6px; }
  .legal .eff { color: var(--ink-3); font-size: 14px; margin: 0 0 34px; }
  .legal-s { margin-bottom: 30px; }
  .legal-s h2 { font-size: 17px; margin: 0 0 10px; color: var(--ink); }
  .legal p { color: var(--ink-2); line-height: 1.75; margin: 0 0 12px; font-size: 15px; }
  .legal a { color: var(--accent); }
  .legal ul { color: var(--ink-2); line-height: 1.75; font-size: 15px; padding-inline-start: 22px; }
  .legal li { margin-bottom: 7px; }
  .legal .back { display: inline-block; margin-bottom: 26px; color: var(--ink-3); text-decoration: none; font-size: 14px; }
  .legal .back:hover { color: var(--ink); }
</style>
</head>
<body>
<main class="legal">
  <a class="back" href="/">${lang === 'ar' ? '→ العودة إلى الموقع' : '← Back to the site'}</a>
  <h1>${escapeHtml(title)}</h1>
  <p class="eff">${escapeHtml(effective)}</p>
  ${body}
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

const PRIVACY_EN: Section[] = [
  {
    h: 'Who we are, and who holds what',
    body: [
      'LoyaNexa provides digital loyalty cards that live in Apple Wallet and Google Wallet. Two different relationships are involved, and they matter because they decide who you ask about what.',
      'For the <strong>businesses</strong> who sign up to run a loyalty card, we are the data controller for their account: their email address, business name and sign-in details.',
      'For the <strong>customers</strong> of those businesses, we are a data processor. The business you joined is the controller of your details. We store and process them on that business’s behalf and on its instructions.',
      `In practice that means: if you want your details removed from a café’s loyalty card, the café decides, and we act. You can contact us at <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a> either way, and we will pass the request on if it is not ours to answer.`,
    ],
  },
  {
    h: 'What we collect from customers',
    body: [
      'Everything below is optional except the card itself. A customer can join with nothing but a tap.',
      `<ul>
        <li><strong>Name</strong> — optional. Used to greet you on the card.</li>
        <li><strong>Phone number</strong> — optional. Used to find your card at the counter if you lose your phone, and to recognise you if you re-join so your stamps are not lost.</li>
        <li><strong>Email address</strong> — optional.</li>
        <li><strong>Birthday</strong> — optional, and <strong>only the day and month</strong>. We deliberately discard the year at the moment you type it: it is never written down, never stored, and never sent anywhere. A full date of birth is a genuine identity-theft input and a birthday greeting does not need one.</li>
        <li><strong>Your stamps and rewards</strong> — when you collected them, and at which business.</li>
        <li><strong>A device token</strong> — issued by Apple or Google so your card can update itself on your phone. It identifies a device, not a person, and we cannot read anything on your phone with it.</li>
      </ul>`,
      'We do not collect your location. Cards can be set to appear on your lock screen near a shop, but that check happens entirely on your phone — the shop’s address is inside the card, and your position never leaves your device or reaches us.',
      'We do not use tracking cookies or advertising trackers. The only cookies we set are the one that remembers your language and, for business accounts, the one that keeps you signed in.',
    ],
  },
  {
    h: 'Why we are allowed to hold it',
    body: [
      'For customers, the lawful basis is <strong>consent</strong>: you tick a box on the join page before anything is stored, and joining is an entirely voluntary act. You can withdraw that consent at any time by deleting the card from your wallet and asking the business to remove your details.',
      'For businesses, the lawful basis is <strong>contract</strong>: we cannot provide the service without an account.',
    ],
  },
  {
    h: 'Who else sees it',
    body: [
      'We do not sell personal data, and we do not share it with anyone for their own purposes. The following organisations process some of it in order for the product to work at all:',
      `<ul>
        <li><strong>Apple</strong> — receives a device token in order to deliver the silent update that refreshes your card after a stamp. The update carries no content: your name, your stamp count and your rewards are not in it.</li>
        <li><strong>Google</strong> — for cards saved to Google Wallet, holds the card’s contents in order to display it.</li>
        <li><strong>Fly.io</strong> — hosts the application and the database, in London.</li>
        <li><strong>Google Fonts</strong> — serves the typeface. Loading it means your browser contacts Google and, unavoidably, reveals your IP address to them. We consider this a shortcoming rather than a feature and intend to serve the font ourselves.</li>
      </ul>`,
    ],
  },
  {
    h: 'Where it is kept, and for how long',
    body: [
      'All data is stored in the United Kingdom (London).',
      'Customer details are kept for as long as the card exists. If the business deletes the card, everything attached to it — passes, stamp history and any details you gave — is deleted with it, permanently and immediately. If you delete the card from your wallet, it stops updating; ask the business to erase the details too if that is what you want.',
      'Notification messages are deliberately short-lived: a message sent to a card expires after fifteen minutes and is then erased from our database, not merely hidden.',
      'Business accounts are kept while the account is open.',
    ],
  },
  {
    h: 'Your rights',
    body: [
      'Under the UK GDPR you may ask for a copy of your data, ask for it to be corrected, ask for it to be deleted, ask us to stop processing it, or ask for it in a portable form. You may also complain to the Information Commissioner’s Office at <a href="https://ico.org.uk">ico.org.uk</a>.',
      `Write to <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a>. We will respond within one month. If you are a customer of a business using LoyaNexa, we will forward the request to that business, because it is theirs to decide — and we will tell you that we have done so.`,
    ],
  },
  {
    h: 'How it is protected',
    body: [
      'The site is served over HTTPS only. Passwords are stored using scrypt and are never recoverable, by us or by anyone. Sign-in sessions are held in cookies your browser will not let a script read. Every business can see only its own cards and its own customers, and this is enforced on the server rather than in the interface.',
      'Staff members can be given a PIN that opens the stamping screen and nothing else — no customer list, no reports, no settings.',
      'We are honest about the limits: no system is perfectly secure. If a breach affects your rights we will report it to the ICO within 72 hours and tell the people affected.',
    ],
  },
  {
    h: 'Changes',
    body: [
      'If this policy changes materially we will change the date at the top and, where the change affects customers, ask the businesses using LoyaNexa to make it known.',
    ],
  },
];

const PRIVACY_AR: Section[] = [
  {
    h: 'من نحن، ومن يملك ماذا',
    body: [
      'تقدّم LoyaNexa بطاقات ولاء رقمية تعيش داخل محفظة آبل ومحفظة جوجل. وهناك علاقتان مختلفتان هنا، والتمييز بينهما مهم لأنه يحدّد إلى مَن تتوجّه بسؤالك.',
      'بالنسبة إلى <strong>المتاجر</strong> التي تشترك لتشغيل بطاقة ولاء، نحن المتحكّم في بيانات حسابها: البريد الإلكتروني واسم النشاط وبيانات الدخول.',
      'أمّا بالنسبة إلى <strong>عملاء تلك المتاجر</strong>، فنحن معالِج للبيانات لا متحكّم فيها. المتجر الذي انضممت إليه هو المتحكّم في بياناتك، ونحن نخزّنها ونعالجها نيابةً عنه وبتعليماته.',
      `عمليًا: إن أردت حذف بياناتك من بطاقة ولاء مقهى ما، فالقرار للمقهى ونحن ننفّذ. ويمكنك مراسلتنا في الحالتين على <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a> وسنحوّل الطلب إن لم يكن من حقّنا البتّ فيه.`,
    ],
  },
  {
    h: 'ما الذي نجمعه من العملاء',
    body: [
      'كل ما يلي اختياري عدا البطاقة نفسها؛ إذ يمكن الانضمام دون إدخال أي بيانات.',
      `<ul>
        <li><strong>الاسم</strong> — اختياري، ويُستخدم للترحيب بك على البطاقة.</li>
        <li><strong>رقم الهاتف</strong> — اختياري، ويُستخدم للعثور على بطاقتك عند الكاونتر إن فقدت هاتفك، وللتعرّف عليك إن أعدت الانضمام حتى لا تضيع أختامك.</li>
        <li><strong>البريد الإلكتروني</strong> — اختياري.</li>
        <li><strong>تاريخ الميلاد</strong> — اختياري، و<strong>اليوم والشهر فقط</strong>. نتخلّص من السنة عمدًا لحظة كتابتها: لا تُسجَّل ولا تُخزَّن ولا تُرسَل إلى أي جهة. فتاريخ الميلاد الكامل مدخل حقيقي لسرقة الهوية، وتهنئة عيد الميلاد لا تحتاجه.</li>
        <li><strong>أختامك ومكافآتك</strong> — متى حصلت عليها، وفي أي متجر.</li>
        <li><strong>رمز الجهاز</strong> — تصدره آبل أو جوجل ليتمكّن هاتفك من تحديث البطاقة تلقائيًا. وهو يعرّف جهازًا لا شخصًا، ولا يتيح لنا قراءة أي شيء على هاتفك.</li>
      </ul>`,
      'لا نجمع موقعك. يمكن ضبط البطاقة لتظهر على شاشة القفل قرب المتجر، لكن هذا الفحص يجري بالكامل داخل هاتفك — عنوان المتجر مخزَّن داخل البطاقة، وموقعك لا يغادر جهازك ولا يصل إلينا.',
      'لا نستخدم ملفات تتبّع ولا أدوات تتبّع إعلانية. الملفات الوحيدة التي نحفظها هي ملف اللغة، وملف إبقاء حساب المتجر مسجَّل الدخول.',
    ],
  },
  {
    h: 'الأساس القانوني للاحتفاظ بها',
    body: [
      'بالنسبة إلى العملاء، الأساس هو <strong>الموافقة</strong>: تضع علامة في مربّع على صفحة الانضمام قبل تخزين أي شيء، والانضمام فعل طوعي بالكامل. ويمكنك سحب الموافقة في أي وقت بحذف البطاقة من محفظتك وطلب حذف بياناتك من المتجر.',
      'وبالنسبة إلى المتاجر، الأساس هو <strong>العقد</strong>: لا يمكننا تقديم الخدمة دون حساب.',
    ],
  },
  {
    h: 'من يطّلع عليها غيرنا',
    body: [
      'نحن لا نبيع البيانات الشخصية ولا نشاركها مع أي جهة لأغراضها الخاصة. وتعالج الجهات التالية جزءًا منها لأن المنتج لا يعمل بدونها:',
      `<ul>
        <li><strong>آبل</strong> — تتلقّى رمز الجهاز لتوصيل التحديث الصامت الذي يُحدِّث بطاقتك بعد الختم. ولا يحمل هذا التحديث أي محتوى: اسمك وعدد أختامك ومكافآتك ليست بداخله.</li>
        <li><strong>جوجل</strong> — للبطاقات المحفوظة في محفظة جوجل، تحتفظ بمحتوى البطاقة لعرضها.</li>
        <li><strong>Fly.io</strong> — تستضيف التطبيق وقاعدة البيانات في لندن.</li>
        <li><strong>خطوط جوجل</strong> — تقدّم الخط المستخدم. وتحميله يعني أن متصفّحك يتّصل بجوجل ويكشف لها عنوان IP الخاص بك حُكمًا. ونعدّ هذا نقصًا لا ميزة، وننوي استضافة الخط بأنفسنا.</li>
      </ul>`,
    ],
  },
  {
    h: 'أين تُحفظ، وإلى متى',
    body: [
      'تُخزَّن جميع البيانات في المملكة المتحدة (لندن).',
      'تُحفظ بيانات العملاء ما دامت البطاقة قائمة. وإذا حذف المتجر البطاقة، حُذف معها كل ما يتّصل بها — البطاقات الصادرة وسجل الأختام وأي بيانات قدّمتها — حذفًا نهائيًا وفوريًا. وإذا حذفت البطاقة من محفظتك توقّفت عن التحديث؛ اطلب من المتجر حذف البيانات أيضًا إن كان ذلك مرادك.',
      'ورسائل الإشعارات قصيرة العمر عمدًا: تنتهي صلاحية الرسالة بعد خمس عشرة دقيقة ثم تُمحى من قاعدة بياناتنا لا تُخفى فحسب.',
      'وتُحفظ حسابات المتاجر ما دام الحساب مفتوحًا.',
    ],
  },
  {
    h: 'حقوقك',
    body: [
      'بموجب اللائحة العامة لحماية البيانات في المملكة المتحدة، يحقّ لك طلب نسخة من بياناتك، أو تصحيحها، أو حذفها، أو إيقاف معالجتها، أو الحصول عليها بصيغة قابلة للنقل. ويحقّ لك أيضًا تقديم شكوى إلى مكتب مفوّض المعلومات على <a href="https://ico.org.uk">ico.org.uk</a>.',
      `راسلنا على <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a> وسنردّ خلال شهر واحد. وإن كنت عميلًا لمتجر يستخدم LoyaNexa فسنحوّل الطلب إلى ذلك المتجر لأن القرار قراره — وسنُعلمك بأننا فعلنا ذلك.`,
    ],
  },
  {
    h: 'كيف تُحمى',
    body: [
      'يُقدَّم الموقع عبر HTTPS حصرًا. وتُخزَّن كلمات المرور باستخدام scrypt ولا يمكن استرجاعها، لا منّا ولا من غيرنا. وتُحفظ جلسات الدخول في ملفات تعريف لا يسمح متصفّحك لأي سكربت بقراءتها. ولا يرى أي متجر سوى بطاقاته وعملائه هو، وهذا مفروض على الخادم لا في الواجهة فقط.',
      'ويمكن منح الموظفين رمزًا سريًّا يفتح شاشة الختم فقط — دون قائمة العملاء أو التقارير أو الإعدادات.',
      'ونحن صريحون بشأن الحدود: لا يوجد نظام آمن تمامًا. وإذا وقع خرق يمسّ حقوقك فسنبلّغ الجهة المختصّة خلال ٧٢ ساعة ونُخطر المتأثّرين.',
    ],
  },
  {
    h: 'التعديلات',
    body: [
      'إن تغيّرت هذه السياسة تغيّرًا جوهريًّا فسنغيّر التاريخ في أعلى الصفحة، وسنطلب من المتاجر التي تستخدم LoyaNexa إعلام عملائها متى مسّ التغيير العملاء.',
    ],
  },
];

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

const TERMS_EN: Section[] = [
  {
    h: 'What this is',
    body: [
      'These terms cover the use of LoyaNexa by a business running a loyalty card. If you are a customer who has joined a card, these terms are not aimed at you — the privacy policy is the document that concerns you.',
    ],
  },
  {
    h: 'Your account',
    body: [
      'You are responsible for what happens under your account, including anything done by staff you give a PIN to. Keep your password to yourself, and remove staff PINs when people leave.',
      'You must be entitled to run a business in your jurisdiction, and the loyalty programme you run must be lawful there.',
    ],
  },
  {
    h: 'Your customers are yours',
    body: [
      'The customer details collected through your cards belong to you, not to us. We do not sell them, we do not market to them, and we do not use them to build anything of our own. You can export them at any time.',
      'You are the data controller for those details, which means the legal duty to handle them properly is yours. We are your processor and act on your instructions.',
    ],
  },
  {
    h: 'What you promise your customers',
    body: [
      'A loyalty card is a promise. If you say ten stamps earn a free coffee, you owe a free coffee at ten stamps. We deliberately freeze a card’s stamp count, reward and expiry rules once the first customer has joined, so the rules cannot change under someone who is halfway through.',
      'You may still change the design, colours, images and wording at any time.',
      'Deleting a card stops every card already in a customer’s wallet from working. That is irreversible, we cannot notify those customers on your behalf, and you are responsible for honouring what you promised them.',
    ],
  },
  {
    h: 'Messages you send',
    body: [
      'You can send messages to your card holders. They must relate to the loyalty programme they joined, and they must not be unsolicited marketing for anything else.',
      'Sending too many is the fastest way to have your card deleted, and we rate-limit broadcasts partly to protect you from that. We may suspend an account that uses messaging abusively.',
    ],
  },
  {
    h: 'What we provide, and what we do not promise',
    body: [
      'We aim to keep the service running and updating quickly, but we do not guarantee uninterrupted service. Parts of the product depend on Apple and Google, and neither is under our control.',
      'The service is provided as it is. To the extent the law allows, we are not liable for indirect or consequential loss, including lost custom or lost goodwill.',
    ],
  },
  {
    h: 'Ending it',
    body: [
      'You may close your account at any time. We may suspend or close an account that breaks these terms, or that is used unlawfully. If we close your account other than for a breach, we will give you reasonable notice and a chance to export your data.',
      'Closing your account deletes your cards, which stops every card in your customers’ wallets from working.',
    ],
  },
  {
    h: 'Law',
    body: [
      'These terms are governed by the law of England and Wales, and its courts have jurisdiction.',
    ],
  },
];

const TERMS_AR: Section[] = [
  {
    h: 'ما هذه الشروط',
    body: [
      'تغطّي هذه الشروط استخدام LoyaNexa من قِبل متجر يشغّل بطاقة ولاء. وإن كنت عميلًا انضمّ إلى بطاقة فهذه الشروط ليست موجّهة إليك، وسياسة الخصوصية هي المستند الذي يعنيك.',
    ],
  },
  {
    h: 'حسابك',
    body: [
      'أنت مسؤول عمّا يجري تحت حسابك، بما في ذلك ما يفعله الموظفون الذين تمنحهم رمزًا سريًّا. احتفظ بكلمة مرورك لنفسك، واحذف رموز الموظفين عند انتهاء عملهم.',
      'ويجب أن تكون مخوَّلًا بممارسة النشاط التجاري في بلدك، وأن يكون برنامج الولاء الذي تشغّله مشروعًا فيه.',
    ],
  },
  {
    h: 'عملاؤك ملكك',
    body: [
      'بيانات العملاء المجمّعة عبر بطاقاتك ملك لك لا لنا. نحن لا نبيعها، ولا نسوّق لهم، ولا نستخدمها لبناء أي شيء خاص بنا. ويمكنك تصديرها في أي وقت.',
      'وأنت المتحكّم في تلك البيانات، ما يعني أن الواجب القانوني في التعامل معها يقع عليك. ونحن معالِج يعمل بتعليماتك.',
    ],
  },
  {
    h: 'ما تَعِد به عملاءك',
    body: [
      'بطاقة الولاء وعد. فإن قلت إن عشرة أختام تمنح قهوة مجانية، فأنت مدين بقهوة مجانية عند الختم العاشر. ونحن نجمّد عمدًا عدد الأختام والمكافأة وقواعد انتهاء الصلاحية بمجرّد انضمام أول عميل، حتى لا تتغيّر القواعد على مَن قطع نصف الطريق.',
      'ويبقى بإمكانك تغيير التصميم والألوان والصور والنصوص في أي وقت.',
      'وحذف البطاقة يوقف عمل كل بطاقة موجودة فعلًا في محافظ العملاء. وهذا إجراء لا رجعة فيه، ولا يمكننا إشعار أولئك العملاء نيابةً عنك، وتبقى مسؤولية الوفاء بما وعدتهم به عليك.',
    ],
  },
  {
    h: 'الرسائل التي ترسلها',
    body: [
      'يمكنك إرسال رسائل إلى حاملي بطاقتك. ويجب أن تتّصل ببرنامج الولاء الذي انضمّوا إليه، وألّا تكون تسويقًا غير مرغوب فيه لشيء آخر.',
      'والإكثار منها أسرع طريق إلى حذف بطاقتك، ونحن نحدّ من معدّل الإرسال جزئيًّا لحمايتك من ذلك. وقد نوقف أي حساب يسيء استخدام الرسائل.',
    ],
  },
  {
    h: 'ما نقدّمه وما لا نضمنه',
    body: [
      'نسعى لإبقاء الخدمة عاملة وسريعة التحديث، لكننا لا نضمن استمرارها دون انقطاع. وتعتمد أجزاء من المنتج على آبل وجوجل، وكلتاهما خارج سيطرتنا.',
      'وتُقدَّم الخدمة كما هي. وفي الحدود التي يسمح بها القانون، لا نتحمّل المسؤولية عن الخسائر غير المباشرة أو التبعية، بما فيها فقدان الزبائن أو السمعة.',
    ],
  },
  {
    h: 'إنهاء الاستخدام',
    body: [
      'يمكنك إغلاق حسابك في أي وقت. ويمكننا إيقاف أو إغلاق أي حساب يخالف هذه الشروط أو يُستخدم بصورة غير مشروعة. وإن أغلقنا حسابك لسبب غير المخالفة فسنمنحك مهلة معقولة وفرصة لتصدير بياناتك.',
      'وإغلاق حسابك يحذف بطاقاتك، ما يوقف عمل كل بطاقة في محافظ عملائك.',
    ],
  },
  {
    h: 'القانون',
    body: [
      'تخضع هذه الشروط لقانون إنجلترا وويلز، وتختصّ محاكمه بالنظر في أي نزاع.',
    ],
  },
];

export function renderPrivacy(lang: Lang): string {
  return lang === 'ar'
    ? renderDoc('ar', 'سياسة الخصوصية', `سارية من ${LEGAL_EFFECTIVE_DATE_AR}`, PRIVACY_AR)
    : renderDoc('en', 'Privacy policy', `In effect from ${LEGAL_EFFECTIVE_DATE}`, PRIVACY_EN);
}

export function renderTerms(lang: Lang): string {
  return lang === 'ar'
    ? renderDoc('ar', 'شروط الخدمة', `سارية من ${LEGAL_EFFECTIVE_DATE_AR}`, TERMS_AR)
    : renderDoc('en', 'Terms of service', `In effect from ${LEGAL_EFFECTIVE_DATE}`, TERMS_EN);
}
