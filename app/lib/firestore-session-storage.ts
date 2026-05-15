/**
 * FirestoreSessionStorage — Shopify SessionStorage adapter backed by GCP Firestore.
 *
 * Why: Vercel serverless functions wipe MemorySessionStorage on every cold start,
 * which breaks `unauthenticated.admin()` and `authenticate.public.appProxy()` for
 * the customer-facing review form. Firestore (default DB, asia-northeast1) gives
 * us persistent storage on Google Cloud free tier.
 *
 * Env vars required:
 *   - GCP_PROJECT_ID = "astromeda-marketing-prod"
 *   - GCP_SERVICE_ACCOUNT_KEY = full JSON of the service account key (one-line)
 *
 * Collection: "shopify_sessions"
 * Doc id: session.id
 */
import { Firestore } from "@google-cloud/firestore";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { Session } from "@shopify/shopify-api";

const COLLECTION = "shopify_sessions";

function buildFirestoreClient(): Firestore {
  const projectId = process.env.GCP_PROJECT_ID;
  const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (!projectId || !keyJson) {
    throw new Error(
      "GCP_PROJECT_ID and GCP_SERVICE_ACCOUNT_KEY env vars are required for FirestoreSessionStorage"
    );
  }
  const credentials = JSON.parse(keyJson);
  return new Firestore({ projectId, credentials });
}

export class FirestoreSessionStorage implements SessionStorage {
  private db: Firestore;
  constructor() {
    this.db = buildFirestoreClient();
  }

  async storeSession(session: Session): Promise<boolean> {
    const data = session.toPropertyArray().reduce<Record<string, unknown>>((acc, [k, v]) => {
      acc[k] = v;
      return acc;
    }, {});
    await this.db.collection(COLLECTION).doc(session.id).set(data);
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const snap = await this.db.collection(COLLECTION).doc(id).get();
    if (!snap.exists) return undefined;
    const data = snap.data();
    if (!data) return undefined;
    const props = Object.entries(data) as [string, string | number | boolean][];
    return Session.fromPropertyArray(props);
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.db.collection(COLLECTION).doc(id).delete();
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (!ids.length) return true;
    const batch = this.db.batch();
    for (const id of ids) batch.delete(this.db.collection(COLLECTION).doc(id));
    await batch.commit();
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const snap = await this.db.collection(COLLECTION).where("shop", "==", shop).get();
    return snap.docs.map((d) => {
      const props = Object.entries(d.data()) as [string, string | number | boolean][];
      return Session.fromPropertyArray(props);
    });
  }
}
