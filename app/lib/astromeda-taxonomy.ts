/**
 * ASTROMEDA タクソノミー定数
 *
 * メール設定の階層ドリルダウンで使用。
 * CLAUDE.md の COLLABS / 8 色カラー / GPU 一覧を集約。
 */

export interface IpCollab {
  handle: string;           // Shopify collection handle (親コレクション)
  jpName: string;            // 日本語表示名
  productCollectionHandle?: string; // 親コレクション未作成の場合のサブコレクション
}

// CLAUDE.md COLLABS から抽出した 26 IP コラボ
export const IP_COLLABS: IpCollab[] = [
  { handle: "one-piece-bountyrush-collaboration", jpName: "ONE PIECE バウンティラッシュ" },
  { handle: "naruto-shippuden", jpName: "NARUTO-ナルト- 疾風伝" },
  { handle: "heroaca-collaboration", jpName: "僕のヒーローアカデミア" },
  { handle: "streetfighter-collaboration", jpName: "ストリートファイター6" },
  { handle: "sanrio-characters-collaboration", jpName: "サンリオキャラクターズ" },
  { handle: "sega-sonic-astromeda-collaboration", jpName: "ソニック" },
  { handle: "jujutsukaisen-collaboration", jpName: "呪術廻戦" },
  { handle: "chainsawman-movie-reze", jpName: "チェンソーマン レゼ篇" },
  { handle: "bocchi-rocks-collaboration", jpName: "ぼっち・ざ・ろっく！" },
  { handle: "hololive-english-collaboration", jpName: "hololive English" },
  { handle: "bleach-rebirth-of-souls-collaboration", jpName: "BLEACH Rebirth of Souls" },
  { handle: "bleach-anime-astromeda-collaboration", jpName: "BLEACH 千年血戦篇" },
  { handle: "geass-collaboration", jpName: "コードギアス" },
  { handle: "tokyoghoul-collaboration", jpName: "東京喰種" },
  { handle: "lovelive-nijigasaki-collaboration", jpName: "ラブライブ！虹ヶ咲" },
  { handle: "swordart-online-collaboration", jpName: "SAO" },
  { handle: "yurucamp-collaboration", jpName: "ゆるキャン△" },
  { handle: "pacmas-astromeda-collaboration", jpName: "パックマス" },
  { handle: "sumikko", jpName: "すみっコぐらし" },
  { handle: "girls-und-panzer-collaboration", jpName: "ガールズ＆パンツァー" },
  // 親コレクション未作成 (サブコレクション代用)
  { handle: "goods-rilakkuma", jpName: "リラックマ", productCollectionHandle: "goods-rilakkuma" },
  { handle: "pc-nitowai", jpName: "新兎わい", productCollectionHandle: "pc-nitowai" },
  { handle: "astromeda-palworld-collaboration-pc", jpName: "Palworld", productCollectionHandle: "astromeda-palworld-collaboration-pc" },
];

export interface AstromedaColor {
  slug: string;
  jpName: string;
  hex: string;
}

// 8 色カラー (CLAUDE.md の確認済ハンドル)
export const ASTROMEDA_COLORS: AstromedaColor[] = [
  { slug: "white", jpName: "ホワイト", hex: "#ffffff" },
  { slug: "black", jpName: "ブラック", hex: "#1a1a1a" },
  { slug: "pink", jpName: "ピンク", hex: "#ff8db4" },
  { slug: "purple", jpName: "パープル", hex: "#a855f7" },
  { slug: "light-blue", jpName: "ライトブルー", hex: "#7dd3fc" },
  { slug: "red", jpName: "レッド", hex: "#dc2626" },
  { slug: "green", jpName: "グリーン", hex: "#16a34a" },
  { slug: "orange", jpName: "オレンジ", hex: "#f97316" },
];

export interface AstromedaGpu {
  slug: string;
  jpName: string;
  tier: "entry" | "mid" | "high" | "ultra";
}

// 主要 GPU (タグでフィルタする際に使用)
export const ASTROMEDA_GPUS: AstromedaGpu[] = [
  { slug: "rtx4060", jpName: "RTX 4060", tier: "entry" },
  { slug: "rtx4060ti", jpName: "RTX 4060 Ti", tier: "mid" },
  { slug: "rtx4070", jpName: "RTX 4070", tier: "mid" },
  { slug: "rtx4070super", jpName: "RTX 4070 Super", tier: "high" },
  { slug: "rtx4070ti", jpName: "RTX 4070 Ti", tier: "high" },
  { slug: "rtx4080", jpName: "RTX 4080", tier: "high" },
  { slug: "rtx4090", jpName: "RTX 4090", tier: "ultra" },
];

/**
 * 階層選択を Metaobject の target_type / target_handle / target_label に解決する
 */
export type TargetRoot = "astromeda" | "ip_collab";

export interface HierarchicalSelection {
  root: TargetRoot;
  ip?: string;          // IP handle (root=ip_collab)
  color?: string;       // color slug (root=astromeda)
  gpu?: string;         // GPU slug (root=astromeda)
  scope: "all" | "specific";
  productHandle?: string; // when scope=specific
  productTitle?: string;
}

export interface ResolvedTarget {
  target_type: "collection" | "product_tag" | "product" | "all";
  target_handle: string;
  target_label: string;
}

export function resolveTarget(sel: HierarchicalSelection): ResolvedTarget {
  if (sel.root === "ip_collab") {
    const ip = IP_COLLABS.find((x) => x.handle === sel.ip);
    if (!ip) return { target_type: "all", target_handle: "", target_label: "未選択" };
    if (sel.scope === "specific" && sel.productHandle) {
      return {
        target_type: "product",
        target_handle: sel.productHandle,
        target_label: `${ip.jpName}: ${sel.productTitle || sel.productHandle}`,
      };
    }
    // all in IP
    return {
      target_type: "collection",
      target_handle: ip.productCollectionHandle || ip.handle,
      target_label: `${ip.jpName} 全商品`,
    };
  }

  // astromeda (非 IP コラボ ゲーミングPC)
  const color = sel.color ? ASTROMEDA_COLORS.find((c) => c.slug === sel.color) : null;
  const gpu = sel.gpu ? ASTROMEDA_GPUS.find((g) => g.slug === sel.gpu) : null;
  const colorLabel = color ? color.jpName : "全色";
  const gpuLabel = gpu ? gpu.jpName : "全GPU";

  if (sel.scope === "specific" && sel.productHandle) {
    return {
      target_type: "product",
      target_handle: sel.productHandle,
      target_label: `アストロメダPC ${colorLabel}/${gpuLabel}: ${sel.productTitle || sel.productHandle}`,
    };
  }

  // color + gpu both specified → product_tag like color-purple-gpu-rtx4060
  if (color && gpu) {
    return {
      target_type: "product_tag",
      target_handle: `${color.slug}+${gpu.slug}`,
      target_label: `アストロメダPC ${color.jpName} × ${gpu.jpName}`,
    };
  }
  // only color → use color collection
  if (color) {
    return {
      target_type: "collection",
      target_handle: color.slug,
      target_label: `アストロメダPC ${color.jpName}`,
    };
  }
  // only gpu → product_tag
  if (gpu) {
    return {
      target_type: "product_tag",
      target_handle: gpu.slug,
      target_label: `アストロメダPC ${gpu.jpName}`,
    };
  }
  // nothing specified → all astromeda gaming PCs
  return {
    target_type: "collection",
    target_handle: "gaming-pc",
    target_label: "アストロメダPC 全商品",
  };
}

/**
 * Metaobject の target_type / target_handle を階層選択に逆解決する (編集時に使う)
 */
export function inferSelection(target_type: string, target_handle: string): HierarchicalSelection {
  // IP collab collection?
  const ipMatch = IP_COLLABS.find((ip) => ip.handle === target_handle || ip.productCollectionHandle === target_handle);
  if (target_type === "collection" && ipMatch) {
    return { root: "ip_collab", ip: ipMatch.handle, scope: "all" };
  }
  // Astromeda color collection
  const colorMatch = ASTROMEDA_COLORS.find((c) => c.slug === target_handle);
  if (target_type === "collection" && colorMatch) {
    return { root: "astromeda", color: colorMatch.slug, scope: "all" };
  }
  if (target_type === "collection" && target_handle === "gaming-pc") {
    return { root: "astromeda", scope: "all" };
  }
  if (target_type === "product_tag") {
    // color+gpu pattern: e.g. "purple+rtx4060"
    if (target_handle.includes("+")) {
      const [c, g] = target_handle.split("+");
      return { root: "astromeda", color: c, gpu: g, scope: "all" };
    }
    // GPU only
    const gpuMatch = ASTROMEDA_GPUS.find((g) => g.slug === target_handle);
    if (gpuMatch) return { root: "astromeda", gpu: gpuMatch.slug, scope: "all" };
  }
  // product → unknown root, default astromeda
  if (target_type === "product") {
    return { root: "astromeda", scope: "specific", productHandle: target_handle };
  }
  return { root: "astromeda", scope: "all" };
}
