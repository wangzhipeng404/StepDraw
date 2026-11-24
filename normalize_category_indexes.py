#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
整理 data/ 下二级目录的 index.json：补全缺失索引、适配新结构。

对每个 data/<group>/<cat>/ 目录做：
    0. 没有 index.json 时自动扫描案例 JSON 生成
    1. 更新 index.json 的 name / emoji（映射表，未命中的保持原样）
    2. 修正 items[].thumbnail 为 "<group>/<cat>/<id>.png"
    3. 修正单个案例 JSON 里的 thumbnail 字段（不一致才写）
    4. 重建 index.json（count 以 items 实际数量为准）

用法:
    python normalize_category_indexes.py [仅处理指定 group ...]
"""

import json
import os
import sys

DATA_DIR = "web/public/data"

# ==================== 名称映射（key: <group>/<cat> 或顶层 <cat>） ====================
# 顶层扁平类别（目录本身即类别）
NAME_MAP = {
    "linedrawer": "漫画",
    "featured": "综合",
    "animals": "动物",
    "plants": "植物",
    # aiposegallery
    "aiposegallery/pose": "姿态",
    "aiposegallery/portrait": "肖像",
    "aiposegallery/costume": "服装",
    # quickdraw（原有中文名，无需映射）
    "quickdraw/bear": "熊", "quickdraw/bird": "鸟", "quickdraw/cat": "猫",
    "quickdraw/cow": "牛", "quickdraw/dog": "狗", "quickdraw/elephant": "大象",
    "quickdraw/fish": "鱼", "quickdraw/horse": "马", "quickdraw/panda": "熊猫",
    "quickdraw/pig": "猪", "quickdraw/rabbit": "兔子",
    # tuberlin
    "tuberlin/airplane": "飞机", "tuberlin/alarmclock": "闹钟",
    "tuberlin/angel": "天使", "tuberlin/ant": "蚂蚁", "tuberlin/apple": "苹果",
    "tuberlin/arm": "手臂", "tuberlin/armchair": "扶手椅",
    "tuberlin/ashtray": "烟灰缸", "tuberlin/axe": "斧头",
    "tuberlin/backpack": "背包", "tuberlin/banana": "香蕉", "tuberlin/barn": "谷仓",
    "tuberlin/baseballbat": "棒球棒", "tuberlin/basket": "篮子",
    "tuberlin/bathtub": "浴缸", "tuberlin/bearanimal": "熊",
    "tuberlin/bed": "床", "tuberlin/bee": "蜜蜂", "tuberlin/beer-mug": "啤酒杯",
    "tuberlin/bell": "铃铛", "tuberlin/bench": "长椅", "tuberlin/bicycle": "自行车",
    "tuberlin/binoculars": "望远镜", "tuberlin/blimp": "飞艇",
    "tuberlin/book": "书", "tuberlin/bookshelf": "书架", "tuberlin/boomerang": "回旋镖",
    "tuberlin/bottleopener": "开瓶器", "tuberlin/bowl": "碗", "tuberlin/brain": "大脑",
    "tuberlin/bread": "面包", "tuberlin/bridge": "桥", "tuberlin/bulldozer": "推土机",
    "tuberlin/bus": "公共汽车", "tuberlin/bush": "灌木", "tuberlin/butterfly": "蝴蝶",
    "tuberlin/cabinet": "橱柜", "tuberlin/cactus": "仙人掌", "tuberlin/cake": "蛋糕",
    "tuberlin/calculator": "计算器", "tuberlin/camel": "骆驼", "tuberlin/camera": "相机",
    "tuberlin/candle": "蜡烛", "tuberlin/cannon": "大炮", "tuberlin/canoe": "独木舟",
    "tuberlin/carrot": "胡萝卜", "tuberlin/carsedan": "汽车",
    "tuberlin/castle": "城堡", "tuberlin/cat": "猫",
    "tuberlin/cellphone": "手机", "tuberlin/chair": "椅子",
    "tuberlin/chandelier": "吊灯", "tuberlin/church": "教堂",
    "tuberlin/cigarette": "香烟", "tuberlin/cloud": "云", "tuberlin/comb": "梳子",
    "tuberlin/computer-mouse": "鼠标", "tuberlin/computermonitor": "显示器",
    "tuberlin/couch": "沙发", "tuberlin/cow": "牛", "tuberlin/crab": "螃蟹",
    "tuberlin/cranemachine": "起重机", "tuberlin/crocodile": "鳄鱼",
    "tuberlin/crown": "皇冠", "tuberlin/cup": "杯子", "tuberlin/diamond": "钻石",
    "tuberlin/dog": "狗", "tuberlin/dolphin": "海豚", "tuberlin/donut": "甜甜圈",
    "tuberlin/door": "门", "tuberlin/doorhandle": "门把手", "tuberlin/dragon": "龙",
    "tuberlin/duck": "鸭子", "tuberlin/ear": "耳朵", "tuberlin/elephant": "大象",
    "tuberlin/envelope": "信封", "tuberlin/eye": "眼睛",
    "tuberlin/eyeglasses": "眼镜", "tuberlin/face": "脸", "tuberlin/fan": "风扇",
    "tuberlin/feather": "羽毛", "tuberlin/firehydrant": "消防栓",
    "tuberlin/fish": "鱼", "tuberlin/flashlight": "手电筒",
    "tuberlin/floorlamp": "落地灯", "tuberlin/flowerwithstem": "花",
    "tuberlin/flyingbird": "飞鸟", "tuberlin/flyingsaucer": "飞碟",
    "tuberlin/foot": "脚", "tuberlin/fork": "叉子", "tuberlin/frog": "青蛙",
    "tuberlin/frying-pan": "平底锅", "tuberlin/giraffe": "长颈鹿",
    "tuberlin/grapes": "葡萄", "tuberlin/grenade": "手榴弹", "tuberlin/guitar": "吉他",
    "tuberlin/hamburger": "汉堡", "tuberlin/hammer": "锤子", "tuberlin/hand": "手",
    "tuberlin/harp": "竖琴", "tuberlin/hat": "帽子", "tuberlin/head": "头",
    "tuberlin/head-phones": "耳机", "tuberlin/hedgehog": "刺猬",
    "tuberlin/helicopter": "直升机", "tuberlin/helmet": "头盔",
    "tuberlin/horse": "马", "tuberlin/hot-dog": "热狗",
    "tuberlin/hotairballoon": "热气球", "tuberlin/hourglass": "沙漏",
    "tuberlin/house": "房子", "tuberlin/human-skeleton": "骨骼",
    "tuberlin/ice-cream-cone": "冰淇淋", "tuberlin/ipod": "播放器",
    "tuberlin/kangaroo": "袋鼠", "tuberlin/key": "钥匙", "tuberlin/keyboard": "键盘",
    "tuberlin/knife": "刀", "tuberlin/ladder": "梯子", "tuberlin/laptop": "笔记本电脑",
    "tuberlin/leaf": "树叶", "tuberlin/lightbulb": "灯泡",
    "tuberlin/lighter": "打火机", "tuberlin/lion": "狮子", "tuberlin/lobster": "龙虾",
    "tuberlin/loudspeaker": "喇叭", "tuberlin/mailbox": "邮箱",
    "tuberlin/megaphone": "扩音器", "tuberlin/mermaid": "美人鱼",
    "tuberlin/microphone": "麦克风", "tuberlin/microscope": "显微镜",
    "tuberlin/monkey": "猴子", "tuberlin/moon": "月亮", "tuberlin/mosquito": "蚊子",
    "tuberlin/motorbike": "摩托车", "tuberlin/mouseanimal": "老鼠",
    "tuberlin/mouth": "嘴", "tuberlin/mug": "马克杯", "tuberlin/mushroom": "蘑菇",
    "tuberlin/nose": "鼻子", "tuberlin/octopus": "章鱼", "tuberlin/owl": "猫头鹰",
    "tuberlin/palmtree": "棕榈树", "tuberlin/panda": "熊猫",
    "tuberlin/paperclip": "回形针", "tuberlin/parachute": "降落伞",
    "tuberlin/parkingmeter": "停车计", "tuberlin/parrot": "鹦鹉",
    "tuberlin/pear": "梨", "tuberlin/pen": "钢笔", "tuberlin/penguin": "企鹅",
    "tuberlin/personsitting": "坐姿人物", "tuberlin/personwalking": "行走人物",
    "tuberlin/piano": "钢琴", "tuberlin/pickuptruck": "皮卡车",
    "tuberlin/pig": "猪", "tuberlin/pigeon": "鸽子", "tuberlin/pineapple": "菠萝",
    "tuberlin/pipeforsmoking": "烟斗", "tuberlin/pizza": "披萨",
    "tuberlin/pottedplant": "盆栽", "tuberlin/poweroutlet": "插座",
    "tuberlin/present": "礼物", "tuberlin/pretzel": "椒盐卷饼",
    "tuberlin/pumpkin": "南瓜", "tuberlin/purse": "手提包", "tuberlin/rabbit": "兔子",
    "tuberlin/racecar": "赛车", "tuberlin/radio": "收音机", "tuberlin/rainbow": "彩虹",
    "tuberlin/revolver": "左轮手枪", "tuberlin/rifle": "步枪",
    "tuberlin/rollerblades": "轮滑鞋", "tuberlin/rooster": "公鸡",
    "tuberlin/sailboat": "帆船", "tuberlin/santaclaus": "圣诞老人",
    "tuberlin/satellite": "卫星", "tuberlin/satellitedish": "卫星天线",
    "tuberlin/saxophone": "萨克斯", "tuberlin/scissors": "剪刀",
    "tuberlin/scorpion": "蝎子", "tuberlin/screwdriver": "螺丝刀",
    "tuberlin/seagull": "海鸥", "tuberlin/seaturtle": "海龟", "tuberlin/shark": "鲨鱼",
    "tuberlin/sheep": "绵羊", "tuberlin/ship": "船", "tuberlin/shoe": "鞋子",
    "tuberlin/shovel": "铲子", "tuberlin/skateboard": "滑板", "tuberlin/skull": "骷髅",
    "tuberlin/skyscraper": "摩天大楼", "tuberlin/snail": "蜗牛", "tuberlin/snake": "蛇",
    "tuberlin/snowboard": "单板滑雪", "tuberlin/snowman": "雪人",
    "tuberlin/socks": "袜子", "tuberlin/spaceshuttle": "航天飞机",
    "tuberlin/speed-boat": "快艇", "tuberlin/spider": "蜘蛛",
    "tuberlin/spongebob": "海绵宝宝", "tuberlin/spoon": "勺子",
    "tuberlin/squirrel": "松鼠", "tuberlin/standingbird": "站立的鸟",
    "tuberlin/stapler": "订书机", "tuberlin/strawberry": "草莓",
    "tuberlin/streetlight": "路灯", "tuberlin/submarine": "潜水艇",
    "tuberlin/suitcase": "行李箱", "tuberlin/sun": "太阳", "tuberlin/suv": "SUV",
    "tuberlin/swan": "天鹅", "tuberlin/sword": "剑", "tuberlin/syringe": "注射器",
    "tuberlin/t-shirt": "T恤", "tuberlin/table": "桌子", "tuberlin/tablelamp": "台灯",
    "tuberlin/teacup": "茶杯", "tuberlin/teapot": "茶壶",
    "tuberlin/teddy-bear": "泰迪熊", "tuberlin/telephone": "电话",
    "tuberlin/tennis-racket": "网球拍", "tuberlin/tent": "帐篷",
    "tuberlin/tiger": "老虎", "tuberlin/tire": "轮胎", "tuberlin/toilet": "马桶",
    "tuberlin/tomato": "番茄", "tuberlin/tooth": "牙齿", "tuberlin/toothbrush": "牙刷",
    "tuberlin/tractor": "拖拉机", "tuberlin/trafficlight": "红绿灯",
    "tuberlin/train": "火车", "tuberlin/tree": "树", "tuberlin/trombone": "长号",
    "tuberlin/trousers": "裤子", "tuberlin/truck": "卡车", "tuberlin/trumpet": "小号",
    "tuberlin/tv": "电视", "tuberlin/umbrella": "雨伞", "tuberlin/van": "面包车",
    "tuberlin/vase": "花瓶", "tuberlin/violin": "小提琴",
    "tuberlin/walkietalkie": "对讲机", "tuberlin/wheel": "轮子",
    "tuberlin/wheelbarrow": "独轮车", "tuberlin/windmill": "风车",
    "tuberlin/wine-bottle": "酒瓶", "tuberlin/wineglass": "酒杯",
    "tuberlin/wrist-watch": "手表", "tuberlin/zebra": "斑马",
    "coloring/nature": "自然",
    "coloring/mandala": "曼陀罗",
    # coloring（角色）
    "coloring/AmongUs": "宇航员",
    "coloring/ArielMermaid": "美人鱼",
    "coloring/Ballerina": "芭蕾舞者",
    "coloring/Beach": "海滩",
    "coloring/Cinnamoroll": "玉桂狗",
    "coloring/DragonBall": "龙珠",
    "coloring/Kitten": "小猫",
    "coloring/Princess": "公主",
    "coloring/SantaClaus": "圣诞老人",
    "coloring/axolotl": "美西螈",
    # coloring（主题 / 题材）
    "coloring/animal": "动物",
    "coloring/architecture": "建筑",
    "coloring/books": "书籍",
    "coloring/butterfly": "蝴蝶",
    "coloring/car": "汽车",
    "coloring/cat": "猫",
    "coloring/celestial": "天体",
    "coloring/dinosaur": "恐龙",
    "coloring/dog": "狗",
    "coloring/dragon": "龙",
    "coloring/fairy": "精灵",
    "coloring/fantasy": "奇幻",
    "coloring/flower": "花",
    "coloring/food": "食物",
    "coloring/geomtric": "几何",
    "coloring/hearts": "爱心",
    "coloring/holiday": "节日",
    "coloring/horse": "马",
    "coloring/landspace": "风景",
    "coloring/mushroom": "蘑菇",
    "coloring/objects": "物品",
    "coloring/patterns": "图案",
    "coloring/people": "人物",
    "coloring/pricess": "公主",
    "coloring/seasons": "季节",
    "coloring/space": "太空",
    "coloring/stainedglass": "彩窗",
    "coloring/trippy": "迷幻",
    "coloring/underwater": "水下",
    "coloring/unicorn": "独角兽",
    "coloring/zodiac": "星座",
}

# ==================== emoji 映射（key 同 NAME_MAP；未命中的保持原样） ====================
EMOJI_MAP = {
    "linedrawer": "🎭",
    "featured": "✨",
    "animals": "🦁", "plants": "🌿",
    "cocomaterial/Buildings": "🏛️", "cocomaterial/Read": "📚",
    "cocomaterial/family": "👨‍👩‍👧‍👦",
    "aiposegallery/pose": "🧘", "aiposegallery/portrait": "🧑", "aiposegallery/costume": "👕",
    "quickdraw/bear": "🐻", "quickdraw/bird": "🐦", "quickdraw/cat": "🐱",
    "quickdraw/cow": "🐮", "quickdraw/dog": "🐶", "quickdraw/elephant": "🐘",
    "quickdraw/fish": "🐟", "quickdraw/horse": "🐴", "quickdraw/panda": "🐼",
    "quickdraw/pig": "🐷", "quickdraw/rabbit": "🐰",
    "tuberlin/cat": "🐱", "tuberlin/dog": "🐶", "tuberlin/bearanimal": "🐻",
    "tuberlin/bird": "🐦", "tuberlin/fish": "🐟", "tuberlin/horse": "🐴",
    "tuberlin/panda": "🐼", "tuberlin/pig": "🐷", "tuberlin/rabbit": "🐰",
    "tuberlin/elephant": "🐘", "tuberlin/lion": "🦁", "tuberlin/tiger": "🐯",
    "tuberlin/snake": "🐍", "tuberlin/monkey": "🐵", "tuberlin/frog": "🐸",
    "tuberlin/butterfly": "🦋", "tuberlin/bee": "🐝", "tuberlin/ant": "🐜",
    "tuberlin/spider": "🕷️", "tuberlin/duck": "🦆", "tuberlin/penguin": "🐧",
    "tuberlin/owl": "🦉", "tuberlin/giraffe": "🦒", "tuberlin/camel": "🐫",
    "tuberlin/owl": "🦉", "tuberlin/dolphin": "🐬", "tuberlin/shark": "🦈",
    "tuberlin/octopus": "🐙", "tuberlin/dragon": "🐉", "tuberlin/snowman": "⛄",
    "tuberlin/umbrella": "☂️", "tuberlin/sun": "☀️", "tuberlin/moon": "🌙",
    "tuberlin/cloud": "☁️", "tuberlin/rainbow": "🌈", "tuberlin/pumpkin": "🎃",
    "tuberlin/apple": "🍎", "tuberlin/banana": "🍌", "tuberlin/grapes": "🍇",
    "tuberlin/pear": "🍐", "tuberlin/pineapple": "🍍", "tuberlin/carrot": "🥕",
    "tuberlin/tomato": "🍅", "tuberlin/pizza": "🍕", "tuberlin/hamburger": "🍔",
    "tuberlin/ice-cream-cone": "🍦", "tuberlin/cake": "🍰", "tuberlin/donut": "🍩",
    "tuberlin/bread": "🍞", "tuberlin/pumpkin": "🎃",
    "tuberlin/house": "🏠", "tuberlin/castle": "🏰", "tuberlin/church": "⛪",
    "tuberlin/tree": "🌳", "tuberlin/cactus": "🌵", "tuberlin/leaf": "🍃",
    "tuberlin/flowerwithstem": "🌸", "tuberlin/mushroom": "🍄",
    "tuberlin/car": "🚗", "tuberlin/carsedan": "🚗", "tuberlin/bus": "🚌",
    "tuberlin/train": "🚂", "tuberlin/airplane": "✈️", "tuberlin/bicycle": "🚲",
    "tuberlin/motorbike": "🏍️", "tuberlin/ship": "🚢", "tuberlin/sailboat": "⛵",
    "tuberlin/submarine": "🛥️", "tuberlin/helicopter": "🚁",
    "tuberlin/hotairballoon": "🎈", "tuberlin/spaceshuttle": "🚀",
    "tuberlin/heart": "❤️", "tuberlin/teapot": "🫖", "tuberlin/mug": "☕",
    "tuberlin/guitar": "🎸", "tuberlin/piano": "🎹", "tuberlin/violin": "🎻",
    "tuberlin/keyboard": "⌨️", "tuberlin/computer-mouse": "🖱️",
    "tuberlin/camera": "📷", "tuberlin/phone": "📱", "tuberlin/cellphone": "📱",
    "tuberlin/telephone": "☎️", "tuberlin/watch": "⌚", "tuberlin/wrist-watch": "⌚",
    "tuberlin/lightbulb": "💡", "tuberlin/hammer": "🔨", "tuberlin/scissors": "✂️",
    "tuberlin/sword": "⚔️", "tuberlin/crown": "👑", "tuberlin/key": "🔑",
    "tuberlin/lamp": "💡", "tuberlin/tablelamp": "💡", "tuberlin/floorlamp": "💡",
    "tuberlin/santaclaus": "🎅", "tuberlin/present": "🎁",
    "tuberlin/star": "⭐", "tuberlin/rocket": "🚀", "tuberlin/heart": "❤️",
    "coloring/nature": "🌸",
    "coloring/mandala": "🕸️",
    # coloring（角色）
    "coloring/AmongUs": "👨‍🚀",
    "coloring/ArielMermaid": "🧜‍♀️",
    "coloring/Ballerina": "🩰",
    "coloring/Beach": "🏖️",
    "coloring/Cinnamoroll": "🐶",
    "coloring/DragonBall": "🐉",
    "coloring/Kitten": "🐱",
    "coloring/Princess": "👸",
    "coloring/SantaClaus": "🎅",
    "coloring/axolotl": "🦎",
    # coloring（主题 / 题材）
    "coloring/animal": "🦁",
    "coloring/architecture": "🏛️",
    "coloring/books": "📖",
    "coloring/butterfly": "🦋",
    "coloring/car": "🚗",
    "coloring/cat": "🐱",
    "coloring/celestial": "🌙",
    "coloring/dinosaur": "🦕",
    "coloring/dog": "🐶",
    "coloring/dragon": "🐉",
    "coloring/fairy": "🧚",
    "coloring/fantasy": "🐲",
    "coloring/flower": "🌺",
    "coloring/food": "🍽️",
    "coloring/geomtric": "📐",
    "coloring/hearts": "💗",
    "coloring/holiday": "🎉",
    "coloring/horse": "🐴",
    "coloring/landspace": "🏞️",
    "coloring/mushroom": "🍄",
    "coloring/objects": "📦",
    "coloring/patterns": "🌀",
    "coloring/people": "🧑",
    "coloring/pricess": "👸",
    "coloring/seasons": "🍂",
    "coloring/space": "🚀",
    "coloring/stainedglass": "🪟",
    "coloring/trippy": "🫧",
    "coloring/underwater": "🐠",
    "coloring/unicorn": "🦄",
    "coloring/zodiac": "♌",
}


def resolve(mapping, group, cat):
    """先查 <group>/<cat>，再查 <cat>，都没有返回 None"""
    if group and f"{group}/{cat}" in mapping:
        return mapping[f"{group}/{cat}"]
    if cat in mapping:
        return mapping[cat]
    return None


def is_chinese(text):
    return any("一" <= ch <= "鿿" for ch in (text or ""))


def scan_cases(cat_dir):
    """扫描目录下所有案例 JSON（排除 index.json），返回按文件名排序的条目列表"""
    items = []
    for fn in sorted(os.listdir(cat_dir)):
        if not fn.endswith(".json") or fn == "index.json":
            continue
        cid = fn[:-5]
        items.append({
            "id": cid,
            "name": cid,
            "thumbnail": "",       # 由 process_category 统一填充
            "difficulty": 3,       # 未知时默认 3
            "stepCount": 0,        # 尝试从案例文件读取
        })
        case_path = os.path.join(cat_dir, fn)
        try:
            with open(case_path, "r", encoding="utf-8") as f:
                case = json.load(f)
            if case.get("name"):
                items[-1]["name"] = case["name"]
            if case.get("difficulty"):
                items[-1]["difficulty"] = case["difficulty"]
            steps = case.get("steps")
            if isinstance(steps, list):
                items[-1]["stepCount"] = len(steps)
        except Exception:
            pass
    return items


def process_category(group, cat, cat_dir):
    index_path = os.path.join(cat_dir, "index.json")
    if os.path.isfile(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            idx = json.load(f)
    else:
        # 没有索引时自动从案例 JSON 扫描生成
        idx = {
            "category": f"{group}/{cat}" if group else cat,
            "name": cat,
            "viewBox": [0, 0, 256, 256],
            "count": 0,
            "items": scan_cases(cat_dir),
        }

    items = idx.get("items", [])
    prefix = f"{group}/{cat}" if group else cat
    expected_thumb = lambda cid: f"{prefix}/{cid}.png"

    changed_items = 0
    changed_cases = 0
    for item in items:
        cid = item.get("id")
        if not cid:
            continue
        # 修正 index.json 里的 thumbnail
        want = expected_thumb(cid)
        if item.get("thumbnail") != want:
            item["thumbnail"] = want
            changed_items += 1
        # 修正案例文件里的 thumbnail
        case_path = os.path.join(cat_dir, f"{cid}.json")
        if os.path.isfile(case_path):
            try:
                with open(case_path, "r", encoding="utf-8") as f:
                    case = json.load(f)
                if case.get("thumbnail") != want:
                    case["thumbnail"] = want
                    with open(case_path, "w", encoding="utf-8") as f:
                        json.dump(case, f, ensure_ascii=False, separators=(",", ":"))
                    changed_cases += 1
            except Exception:
                pass

    # 更新 name / emoji：NAME_MAP 里有映射则以其为准（可强制改名），
    # 没有映射时保留已有中文名，都没有则用目录名
    mapped_name = resolve(NAME_MAP, group, cat)
    if mapped_name:
        idx["name"] = mapped_name
    elif not is_chinese(idx.get("name") or ""):
        idx["name"] = idx.get("name") or cat

    emoji = resolve(EMOJI_MAP, group, cat)
    if emoji:
        idx["emoji"] = emoji

    idx["category"] = f"{group}/{cat}" if group else cat
    idx["count"] = len(items)
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, separators=(",", ":"))

    print(f"  {idx.get('name')} [{group}/{cat}] {len(items)} 条, "
          f"修正 thumbnail: index {changed_items}, 案例 {changed_cases}")
    return len(items)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isdir(DATA_DIR):
        print(f"[错误] 数据目录不存在：{os.path.abspath(DATA_DIR)}")
        return

    # 可选：只处理指定目录（相对 DATA_DIR），用于增量修正
    only = set(sys.argv[1:]) if len(sys.argv) > 1 else None

    total = 0
    for group in sorted(os.listdir(DATA_DIR)):
        if only and group not in only:
            continue
        group_dir = os.path.join(DATA_DIR, group)
        if not os.path.isdir(group_dir):
            continue

        subdirs = sorted(
            d for d in os.listdir(group_dir) if os.path.isdir(os.path.join(group_dir, d)))
        if subdirs:
            # 二级目录组
            print(f"== {group} ==")
            for cat in subdirs:
                cat_dir = os.path.join(group_dir, cat)
                total += process_category(group, cat, cat_dir)
        elif os.path.isfile(os.path.join(group_dir, "index.json")):
            # 组目录本身就是扁平类别（如 linedrawer）
            print(f"== {group} (扁平) ==")
            total += process_category(None, group, group_dir)

    print("=" * 40)
    print(f"完成，共 {total} 条案例")


if __name__ == "__main__":
    main()
