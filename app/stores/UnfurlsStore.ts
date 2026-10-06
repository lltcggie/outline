import { subMinutes } from "date-fns";
import { action, makeObservable, override } from "mobx";
import { errToString } from "@shared/utils/error";
import type { UnfurlResourceType } from "@shared/types";
import Unfurl from "~/models/Unfurl";
import { client } from "~/utils/ApiClient";
import Logger from "~/utils/Logger";
import type RootStore from "./RootStore";
import Store from "./base/Store";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
class UnfurlsStore extends Store<Unfurl<any>> {
  actions = []; // no default actions allowed for unfurls.

  constructor(rootStore: RootStore) {
    super(rootStore, Unfurl);
    makeObservable(this);
  }

  /** Time that a url last returned no unfurl data, keyed by url. */
  private emptyFetchedAt = new Map<string, number>();

  /** Unfurl requests that are in progress, keyed by url and document. */
  private inflight = new Map<
    string,
    Promise<Unfurl<UnfurlResourceType> | undefined>
  >();

  fetchUnfurl = async ({
    url,
    documentId,
  }: {
    url: string;
    documentId?: string;
  }): Promise<Unfurl<UnfurlResourceType> | undefined> => {
    try {
      const protocol = new URL(url).protocol;
      if (
        protocol !== "http:" &&
        protocol !== "https:" &&
        protocol !== "mention:"
      ) {
        return;
      }
    } catch (_err) {
      return;
    }

    const unfurl = this.get(url);

    if (unfurl) {
      // A result fetched a while ago is shown while it is fetched again.
      if (new Date(unfurl.fetchedAt) < subMinutes(new Date(), 5)) {
        void this.request({ url, documentId });
      }
      return unfurl;
    }

    return this.request({ url, documentId });
  };

  @override
  clear() {
    super.clear();
    // What the user can see may have changed, so urls are asked for again.
    this.emptyFetchedAt.clear();
  }

  /**
   * Requests an unfurl, skipping urls that recently returned no data and
   * sharing a request that is already in progress for the same url.
   */
  private request = ({
    url,
    documentId,
  }: {
    url: string;
    documentId?: string;
  }): Promise<Unfurl<UnfurlResourceType> | undefined> => {
    const emptyAt = this.emptyFetchedAt.get(url);
    if (emptyAt && emptyAt > subMinutes(new Date(), 5).getTime()) {
      return Promise.resolve(undefined);
    }

    // Mentions of the same url share a single request.
    const key = `${url}:${documentId ?? ""}`;
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.unfurl({ url, documentId }).finally(() =>
      this.inflight.delete(key)
    );
    this.inflight.set(key, promise);
    return promise;
  };

  @action
  private unfurl = async ({
    url,
    documentId,
  }: {
    url: string;
    documentId?: string;
  }): Promise<Unfurl<UnfurlResourceType> | undefined> => {
    try {
      this.isFetching = true;

      const data = await client.post("/urls.unfurl", {
        url,
        documentId,
      });

      // unfurls can succeed with no data, in which case the user can no
      // longer see the resource, so previously fetched data is discarded.
      if (!data) {
        this.emptyFetchedAt.set(url, Date.now());
        this.remove(url);
        return;
      }

      this.emptyFetchedAt.delete(url);

      return this.add({
        id: url,
        type: data.type,
        fetchedAt: new Date().toISOString(),
        data,
      });
    } catch (err) {
      Logger.warn("Failed to unfurl url", {
        url,
        message: errToString(err),
      });
      return;
    } finally {
      this.isFetching = false;
    }
  };
}

export default UnfurlsStore;
