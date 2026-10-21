// إعدادات التطبيق القابلة للتخصيص.
// هذا الملف هو أول مكان يُعدَّل لتخصيص التطبيق (يدويًا أو عبر Claude Code). راجع CLAUDE.md.
// تنبيه: تغيير عدد الأسابيع أو البنود أو الحدود يغيّر قواعد الحساب والتصدير؛ شغّل الاختبارات بعده (npm test).

export const CONFIG = {
  appName: 'متابعة الدرجات',
  version: '2.25.0',
  releaseDate: '2026-10-21',

  // قواعد الدرجات
  weeks: 10,
  criteria: [
    { key: 'b', label: 'السلوك', short: 'سلوك' },
    { key: 't', label: 'الأدوات', short: 'أدوات' },
    { key: 'a', label: 'التطبيق', short: 'تطبيق' },
    { key: 'p', label: 'المشاركة', short: 'مشاركة' },
  ],
  itemMax: 5,
  finals: [
    { key: 'p1', label: 'المشروع الأول', short: 'مشروع 1', max: 10 },
    { key: 'p2', label: 'المشروع الثاني', short: 'مشروع 2', max: 20 },
    { key: 'pr', label: 'الاختبار العملي', short: 'العملي', max: 30 },
  ],
  maxStudents: 60,

  // أزرار الإدخال السريع (نمط الأزرار)
  chipValues: [5, 4.5, 4, 3, 2, 1, 0],

  // تذكير النسخ الاحتياطي بعد هذا العدد من الأيام
  backupReminderDays: 7,

  // العرض الحي: STUN احتياطي فقط (يعمل على نفس الشبكة بدونه غالبًا)
  stunServers: ['stun:stun.l.google.com:19302'],
  // رابط صفحة العرض على الكمبيوتر. فارغ = نفس رابط التطبيق + view.html
  // (في تطبيق أندرويد ضع هنا رابط الاستضافة، مثل https://example.netlify.app/view.html)
  viewUrl: 'https://yousf612-alwazzan.github.io/grades/view.html',
  // خادم المزامنة المشفّرة (نسخة الآيفون والموقع فقط — أندرويد لا يستعمله). فارغ = بلا حسابات.
  cloudUrl: 'https://grades-sync.grades-sync.workers.dev',

  toastMs: 2600,
  saveDebounceMs: 200,
  undoDeleteMs: 10000,

  // أوقات حصص المرحلة المتوسطة [بداية، نهاية] — يُبنى عليها تذكير الحصص من جدول المدرسة
  bells: [['07:40', '08:25'], ['08:30', '09:15'], ['09:30', '10:15'], ['10:20', '11:05'], ['11:10', '11:55'], ['12:05', '12:50'], ['12:55', '13:40']],

  // المادة الافتراضية للجميع إن كانت فارغة (يقدر المعلم يغيّرها من الإعدادات)
  defaultSubject: { ar: 'الحاسوب', en: 'Computer' },
  defaultSettings: {
    teacher: '', subject: '', year: '',
    theme: 'auto', textScale: 'normal', lang: 'ar',
    // تذكير الحصص: الجدول الأسبوعي، والتنبيه قبل الحصة بكم دقيقة، وتشغيل/إيقاف التذكير
    schedule: [], remindBefore: '10', remindersOn: true,
    // أوقات حصص الصفوف تلقائيًا من «جدول المدرسة» (كل صف يأخذ وقت حصته)
    ttAuto: true,
    inputMode: 'chips', autoAdvance: true, haptics: true,
    turnUrl: '', turnUser: '', turnPass: '',
    viewUrl: '', tourDone: false,
    // ما يظهر على شاشة العرض للطلاب: نجوم التميّز (نعم)، علامات التنبيه ❗ (لا)، وطلاب تُخفى عنهم ❗ لكل صف
    liveShowStars: true, liveShowIssues: false, liveIssueHidden: {}, liveAllowEdit: true,
  },
};

export default CONFIG;
