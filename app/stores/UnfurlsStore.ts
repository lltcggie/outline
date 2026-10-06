import { subMinutes } from "date-fns";
import { action, makeObservable } from "mobx";
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
        void this.unfurl({ url, documentId });
      }
      return unfurl;
    }

    return this.unfurl({ url, documentId });
  };

  private unfurl = ({
    url,
    documentId,
  }: {
    url: string;
    documentId?: string;
  }): Promise<Unfurl<UnfurlResourceType> | undefined> => {
    // Mentions of the same url share a single request.
    const key = `${url}:${documentId ?? ""}`;
    const pending = this.requests.get(key);
    if (pending) {
      return pending;
    }

    const request = this.request({ url, documentId }).finally(() =>
      this.requests.delete(key)
    );
    this.requests.set(key, request);
    return request;
  };

  @action
  private request = async ({
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
        this.remove(url);
        return;
      }

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
