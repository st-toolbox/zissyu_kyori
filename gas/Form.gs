/**
 * 実習の通学 確認フォームを作る（2026-10-22）。紙の「通学の確認票」（5. 印刷）と同じ中身
 * 学校のアカウントで1回動かす：script.google.com → 新しいプロジェクト → これを貼る → 関数「makeForm」を選んで ▶実行 → 許可
 * → 実行ログにフォームの URL（学生に配る）と回答の表の URL が出る
 * 学生は学校のアカウントでログインして答える（1人1回・あとで直せる）。住所は聞かない
 * 回答の表を見出しごと全部コピー → アプリの「2. 学生」→「フォームの回答を貼り付け」
 * ⚠️ 質問の文はアプリ（app.js の FORM_Q）が見出しで読む＝ここを変えたら app.js も変える
 */
const MODES = ['徒歩', '自転車', '車', '送迎', 'バス'];
const KINDS = ['電車の駅', 'バス停', '路面電車の電停'];

function makeForm() {
  const d = new Date(), year = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  const form = FormApp.create(year + '年度 実習の通学 確認フォーム');
  form.setDescription('実習先を決めるために、実習中の通学を確かめます。\n' +
    '実習中に乗る駅（バス停）と、そこまでの手段・時間を答えてください。住所は書かないでください（学校がすでに持っています）。');
  try { form.setRequireLogin(true); form.setLimitOneResponsePerUser(true); } catch (_) { Logger.log('⚠️ 学校のアカウントでないため、ログインと1人1回を付けられなかった'); }
  form.setCollectEmail(true).setAllowResponseEdits(true).setShowLinkToRespondAgain(false);
  const minV = FormApp.createTextValidation().requireNumberBetween(0, 180).setHelpText('数字だけ（分）').build();

  form.addTextItem().setTitle('学籍番号').setRequired(true);
  form.addTextItem().setTitle('名前').setRequired(true);
  form.addMultipleChoiceItem().setTitle('小児の希望').setChoiceValues(['希望する', '希望しない']).setRequired(true);
  form.addTextItem().setTitle('ふだん使う駅・バス停の名前').setRequired(true)
    .setHelpText('実習中に乗る所。地図で一番近い所でなくてよい（ふだん使っている所）。正式な名前で。駅なら「駅」は付けなくてよい');
  form.addMultipleChoiceItem().setTitle('その種類').setChoiceValues(KINDS).setRequired(true);
  form.addMultipleChoiceItem().setTitle('そこまでの手段').setChoiceValues(MODES).setRequired(true);
  form.addTextItem().setTitle('家を出てから乗るまでの分').setValidation(minV).setRequired(true)
    .setHelpText('家を出てから駅のホーム（バス停）に着くまで、約何分か。数字だけ');
  form.addMultipleChoiceItem().setTitle('車で実習先まで直接通えますか').setHelpText('自分で運転して、車を使える')
    .setChoiceValues(['はい', 'いいえ']).setRequired(true);
  const jk = form.addMultipleChoiceItem().setTitle('実家からの実習').setRequired(true)
    .setHelpText('いま実家から通っている人は「いま実家に住んでいる」を選ぶ（実家の質問は出ない＝上の駅が実家の駅）');

  const pgJk = form.addPageBreakItem().setTitle('実家から通うとき');
  form.addTextItem().setTitle('実家の最寄りの駅・バス停の名前').setRequired(true);
  form.addMultipleChoiceItem().setTitle('実家の駅の種類').setChoiceValues(KINDS).setRequired(true);
  form.addMultipleChoiceItem().setTitle('実家から駅までの手段').setChoiceValues(MODES).setRequired(true);
  form.addTextItem().setTitle('実家を出てから乗るまでの分').setValidation(minV).setRequired(true);

  const pgEnd = form.addPageBreakItem().setTitle('さいごに');
  form.addCheckboxItem().setTitle('確認').setChoiceValues(['実習中は、上の駅・方法で通います']).setRequired(true);
  jk.setChoices([jk.createChoice('可（実家から通ってもよい）', pgJk), jk.createChoice('不可', pgEnd), jk.createChoice('いま実家に住んでいる', pgEnd)]);

  const ss = SpreadsheetApp.create(year + '年度 実習の通学 確認フォーム（回答）');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  Logger.log('学生に配る URL：' + form.getPublishedUrl());
  Logger.log('フォームを直す URL：' + form.getEditUrl());
  Logger.log('回答の表：' + ss.getUrl());
}
