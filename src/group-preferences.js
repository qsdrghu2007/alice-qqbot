// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.
export const GROUP_SAFE_PREFERENCE_CATEGORIES = Object.freeze([
  { label: "游戏", pattern: /游戏|主机|手游|桌游|电竞|switch|steam|xbox|playstation/iu },
  { label: "音乐", pattern: /音乐|歌曲|乐队|歌手|演唱会|专辑|乐器/iu },
  { label: "影视", pattern: /电影|电视剧|动漫|番剧|综艺|动画/iu },
  { label: "阅读", pattern: /阅读|小说|书籍|作者|漫画/iu },
  { label: "美食", pattern: /美食|餐厅|咖啡|饮料|甜点|料理|做饭/iu },
  { label: "运动", pattern: /运动|跑步|健身|篮球|足球|羽毛球|游泳|骑行/iu },
  { label: "旅行", pattern: /旅行|旅游|景点|爬山|徒步/iu },
  { label: "宠物", pattern: /宠物|猫猫|狗狗|养猫|养狗/iu },
  { label: "数码", pattern: /数码|电脑|相机|手机|耳机|键盘/iu },
  { label: "摄影", pattern: /摄影|拍照|镜头|胶片/iu },
]);

export function projectGroupSafePreferenceCategories(memories, groupText) {
  if (!Array.isArray(memories) || !String(groupText ?? "").trim()) return [];
  const labels = new Set();
  for (const memory of memories) {
    if (memory?.type !== "preference") continue;
    const text = String(memory.text ?? "");
    for (const category of GROUP_SAFE_PREFERENCE_CATEGORIES) {
      if (category.pattern.test(text) && category.pattern.test(groupText)) {
        labels.add(category.label);
      }
    }
  }
  return [...labels].slice(0, 6);
}
