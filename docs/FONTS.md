# خط Alexandria — الكود الجاهز للتطبيق

خط ثنائي اللغة (عربي + لاتيني) من Google Fonts، تسعة أوزان، مصمّمه محمد جابر.
لأنه يغطي الحرفين معاً، يغني عن استيراد خطّين منفصلين للعربي والإنجليزي.

---

## 1) HTML / أي مشروع بدون إطار عمل

ضعه في `<head>` قبل ملفات CSS:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>

<link rel="preload" as="style"
  href="https://fonts.googleapis.com/css2?family=Alexandria:wght@300;400;500;600;700;800&display=swap">

<link rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Alexandria:wght@300;400;500;600;700;800&display=swap">

<noscript>
  <link rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Alexandria:wght@300;400;500;600;700;800&display=swap">
</noscript>
```

`preconnect` يفتح الاتصال مبكراً، `preload` يرفع أولوية الملف، و`display=swap`
يعرض النص بخط احتياطي فوراً بدل أن يبقى مخفياً حتى يصل الخط.

---

## 2) Next.js (App Router) — `next/font/google`

هذه الطريقة الصحيحة في Next.js: تستضيف الخط ذاتياً، تحذف طلب الشبكة الخارجي،
وتُلغي قفزة التخطيط (CLS) تلقائياً.

```tsx
// app/layout.tsx
import { Alexandria } from "next/font/google";

const alexandria = Alexandria({
  subsets: ["arabic", "latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-alexandria",
  fallback: ["system-ui", "sans-serif"],
  adjustFontFallback: true,
});

export default function RootLayout({
  children,
  params: { locale },
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  const isArabic = locale === "ar";
  return (
    <html
      lang={locale}
      dir={isArabic ? "rtl" : "ltr"}
      className={alexandria.variable}
    >
      <body className={alexandria.className}>{children}</body>
    </html>
  );
}
```

---

## 3) React / Vite

في أعلى `src/index.css` أو `src/main.css`:

```css
@import url("https://fonts.googleapis.com/css2?family=Alexandria:wght@300;400;500;600;700;800&display=swap");
```

الأفضل للأداء: الاستضافة الذاتية عبر Fontsource، فتتخلص من الاعتماد على نطاق خارجي.

```bash
npm i @fontsource-variable/alexandria
```

```ts
// src/main.tsx
import "@fontsource-variable/alexandria";
```

---

## 4) Tailwind

```js
// tailwind.config.js
export default {
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-alexandria)", "system-ui", "sans-serif"],
      },
    },
  },
};
```

مع Vite (بدون `next/font`) استبدل المتغيّر بالاسم مباشرة:

```js
sans: ["Alexandria", "system-ui", "sans-serif"],
```

ثم في الفئات:

```html
<h1 class="font-sans font-extrabold">…</h1>   <!-- 800 -->
<h2 class="font-sans font-bold">…</h2>        <!-- 700 -->
<button class="font-sans font-semibold">…</button> <!-- 600 -->
<p class="font-sans font-normal">…</p>        <!-- 400 -->
```

---

## 5) الـ CSS الأساسي (يعمل في كل الحالات)

```css
:root {
  --font-sans: "Alexandria", system-ui, sans-serif;
}

html,
body {
  font-family: var(--font-sans);
  font-weight: 400;
  line-height: 1.65;
  /* يمنع المتصفح من تزييف الأوزان الغائبة */
  font-synthesis-weight: none;
  -webkit-font-smoothing: antialiased;
}

/* كل شيء يرث الخط، بما فيه عناصر النماذج التي لا ترث افتراضياً */
button,
input,
select,
textarea {
  font-family: inherit;
}

/* ————— سلّم الأوزان ————— */

/* العنوان الرئيسي */
.display,
h1 {
  font-weight: 800;
  font-size: clamp(2.4rem, 7vw, 4.4rem);
  line-height: 1.04;
  letter-spacing: -0.025em;
}

/* العناوين الفرعية */
h2,
h3,
h4,
.card-title {
  font-weight: 700;
  letter-spacing: -0.02em;
}

/* الأزرار */
button,
.btn,
[role="button"] {
  font-weight: 600;
  letter-spacing: 0;
}

/* النصوص والوصف */
p,
li,
.lede {
  font-weight: 400;
}

/* التسميات الصغيرة */
.label,
th,
.eyebrow {
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

/* ————— دعم العربية و RTL ————— */

/* الحروف العربية أعمق صعوداً ونزولاً، فتحتاج تباعد أسطر أكبر */
html[lang="ar"] body {
  line-height: 1.75;
}

/* التتبّع السالب يضرّ العربية دائماً — صفّره */
html[lang="ar"] h1,
html[lang="ar"] h2,
html[lang="ar"] h3,
html[lang="ar"] .display {
  letter-spacing: 0;
  line-height: 1.3;
}

/* لا تستخدم text-transform مع العربية — لا وجود للحالة فيها */
html[lang="ar"] .label,
html[lang="ar"] th,
html[lang="ar"] .eyebrow {
  text-transform: none;
  letter-spacing: 0;
}

/* الأرقام: Alexandria خط متناسب، فاطلب الأرقام الجدولية صراحةً
   حتى تبقى أعمدة الجداول والإحصاءات محاذاة */
.num,
td,
.price {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}
```

---

## 6) ملاحظات مهمة

**التتبّع (letter-spacing).** Alexandria هندسي وأوسع من Inter، فالتتبّع السالب
الشديد `-0.045em` يجعله مضغوطاً. خُفِّض إلى `-0.025em` للعناوين، وصُفِّر في العربية
لأن التتبّع السالب يفكّ اتصال الحروف العربية ويضرّ قراءتها.

**الأرقام.** كان الموقع يستخدم JetBrains Mono للأرقام والجداول، وقد استُبدل بـ Alexandria
كما طلبت. Alexandria خط متناسب، لذا أُضيفت `tabular-nums` و`'tnum' 1` صراحةً
للحفاظ على محاذاة الأعمدة. إن ظهر أي اختلال في محاذاة الجداول، فإرجاع خط أحادي
المسافة للأرقام وحدها يحتاج تغيير سطر واحد: `--mono`.

**التحقق من النطاق.** إن كان لديك `Content-Security-Policy`، أضف:

```
style-src  'self' https://fonts.googleapis.com;
font-src   'self' https://fonts.gstatic.com;
```

**الأوزان الستة تكفي.** طلبت 300–800، وهي محمّلة. لكن 300 و500 غير مستخدمة حالياً
في التصميم؛ حذفهما من الرابط يوفّر نحو 40–60 كيلوبايت. اتركهما إن كنت تنوي استخدامهما.
