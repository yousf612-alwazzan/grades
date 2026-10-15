// إعدادات التطبيق القابلة للتخصيص.
// هذا الملف هو أول مكان يُعدَّل لتخصيص التطبيق (يدويًا أو عبر Claude Code). راجع CLAUDE.md.
// تنبيه: تغيير عدد الأسابيع أو البنود أو الحدود يغيّر قواعد الحساب والتصدير؛ شغّل الاختبارات بعده (npm test).

export const CONFIG = {
  appName: 'متابعة الدرجات',
  version: '2.0.0',

  // قواعد الدرجات
  weeks: 10,
  criteria: [
    { key: 'b', label: 'السلوك', short: 'سلوك' },
    { key: 't', label: 'الأدوات', short: 'الأدوات' },
    { key: 'a', label: 'التطبيق', short: 'تطبيق' },
    { key: 'p', label: 'المشاركة', short: 'المشاركة' },
  ],
  itemMax: 5,
  finals: [
    { key: 'p1', label: 'المشروع الأول', max: 10 },
    { key: 'p2', label: 'المشروع الثاني', max: 20 },
    { key: 'pr', label: 'الاختبار العملي', max: 30 },
  ],
  maxStudents: 46,

  // أزرار الإدخال السريع (نمط الأزرار)
  chipValues: [5, 4.5, 4, 3, 2, 1, 0],

  // تذكير النسخ الاحتياطي بعد هذا العدد من الأيام
  backupReminderDays: 7,

  // العرض الحي: STUN احتياطي فقط (يعمل على نفس الشبكة بدونه غالبًا)
  stunServers: ['stun:stun.l.google.com:19302'],
  // رابط صفحة العرض على الكمبيوتر. فارغ = نفس رابط التطبيق + view.html
  // (في تطبيق أندرويد ضع هنا رابط الاستضافة، مثل https://example.netlify.app/view.html)
  viewUrl: 'https://yousf612-alwazzan.github.io/grades/view.html',

  toastMs: 2600,
  saveDebounceMs: 200,
  undoDeleteMs: 10000,

  defaultSettings: {
    teacher: '', subject: '', year: '',
    theme: 'auto', textScale: 'normal',
    inputMode: 'chips', autoAdvance: true, haptics: true,
    turnUrl: '', turnUser: '', turnPass: '',
    viewUrl: '', tourDone: false,
  },
};

export default CONFIG;
