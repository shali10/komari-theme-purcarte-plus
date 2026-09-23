// CF-Server-Monitor (CFSM) 适配层 - 用于替代 Komari 原生后端
import type {
  NodeData,
  PublicInfo,
  HistoryRecord,
  LoadHistoryResponse,
  PingHistoryResponse,
  PingHistoryRecord,
  PingTask,
  PingTaskFull,
  Me,
} from "@/types/node";
import type { RpcNodeStatus, RpcNodeStatusMap } from "@/types/rpc";
import type { SiteStatus } from "@/config/default";

export type HistoryQueryRange = {
  start: string;
  end: string;
};

// 运行时缓存
let rawServersCache: any[] = [];
const serverMapCache: Map<string, any> = new Map();
const currentStatusMap: RpcNodeStatusMap = {};

function parseBillingCycleDays(cycle: any): number {
  if (cycle === null || cycle === undefined || cycle === "") return 30;
  const str = String(cycle).trim().toLowerCase();
  if (str === "once" || str === "one_time" || str === "-1") return -1;
  if (str === "month" || str === "monthly") return 30;
  if (str === "quarter" || str === "quarterly") return 92;
  if (str === "half_year" || str === "halfyear" || str === "half-yearly") return 184;
  if (str === "year" || str === "yearly" || str === "annual") return 365;
  if (str === "two_years" || str === "2years") return 730;
  if (str === "three_years" || str === "3years") return 1095;
  if (str === "five_years" || str === "5years") return 1825;

  const num = Number(str);
  if (!isNaN(num)) {
    if (num === -1) return -1;
    if (num === 1) return 30;
    if (num === 3) return 92;
    if (num === 6) return 184;
    if (num === 12) return 365;
    if (num === 24) return 730;
    if (num === 36) return 1095;
    if (num > 0 && num <= 12) return num * 30;
    if (num > 12) return num;
  }
  return 30;
}

function parseTrafficLimitType(type: any): "sum" | "max" | "min" | "up" | "down" {
  const str = String(type || "").trim().toLowerCase();
  if (str === "in" || str === "down" || str === "dl") return "down";
  if (str === "out" || str === "up" || str === "ul") return "up";
  if (str === "max") return "max";
  if (str === "min") return "min";
  return "sum"; // CFSM "total" -> Komari "sum"
}

function parsePrice(p: any): number {
  if (p === null || p === undefined) return 0;
  const str = String(p).trim();
  if (!str) return 0;
  const num = parseFloat(str);
  if (isNaN(num)) return 0;
  if (num === -1 || num === 0) return -1; // 免费/白嫖标记
  return num;
}

function convertServerToNodeData(s: any): NodeData {
  const ramBytes = (Number(s.ram_total) || 0) * 1024 * 1024;
  const swapBytes = (Number(s.swap_total) || 0) * 1024 * 1024;
  const diskBytes = (Number(s.disk_total) || 0) * 1024 * 1024;

  const billingCycleDays = parseBillingCycleDays(s.billing_cycle);
  const priceVal = parsePrice(s.price);

  let trafficLimitBytes: number | undefined = undefined;
  const limitNum = parseFloat(s.traffic_limit);
  if (!isNaN(limitNum) && limitNum > 0) {
    trafficLimitBytes = limitNum * 1024 * 1024 * 1024;
  }

  return {
    uuid: s.id,
    name: s.name || "Unnamed",
    cpu_name: s.cpu_info || "Unknown CPU",
    virtualization: "",
    arch: s.arch || "",
    cpu_cores: Number(s.cpu_cores) || 1,
    os: s.os || "Linux",
    kernel_version: s.kernel_version || "",
    gpu_name: s.gpu_info || "",
    region: s.region || "UN",
    mem_total: ramBytes,
    swap_total: swapBytes,
    disk_total: diskBytes,
    weight: Number(s.sort_order) || 0,
    price: priceVal,
    billing_cycle: billingCycleDays,
    currency: s.currency || "¥",
    expired_at: s.expire_date || null,
    auto_renewal: s.auto_renewal === "1" || s.auto_renewal === true,
    group: s.server_group || "Default",
    tags: s.tags || "",
    public_remark: s.note || "",
    hidden: s.is_hidden === "1" || s.is_hidden === true,
    traffic_limit: trafficLimitBytes,
    traffic_limit_type: parseTrafficLimitType(s.traffic_calc_type),
    created_at: s.boot_time ? new Date(Number(s.boot_time)).toISOString() : new Date().toISOString(),
    updated_at: s.last_updated ? new Date(Number(s.last_updated)).toISOString() : new Date().toISOString(),
  };
}

function convertServerToRpcNodeStatus(s: any): RpcNodeStatus {
  const now = Date.now();
  const lastUpdated = Number(s.last_updated || s.timestamp || 0);
  const isOnline = lastUpdated > 0 && (now - lastUpdated < 300000);

  let load1 = 0, load5 = 0, load15 = 0;
  if (typeof s.load_avg === "string") {
    const parts = s.load_avg.trim().split(/\s+/).map(Number);
    if (!isNaN(parts[0])) load1 = parts[0];
    if (!isNaN(parts[1])) load5 = parts[1];
    if (!isNaN(parts[2])) load15 = parts[2];
  } else if (typeof s.load === "number") {
    load1 = s.load;
  }

  const ramUsedBytes = (Number(s.ram_used) || 0) * 1024 * 1024;
  const ramTotalBytes = (Number(s.ram_total) || 0) * 1024 * 1024;
  const swapUsedBytes = (Number(s.swap_used) || 0) * 1024 * 1024;
  const swapTotalBytes = (Number(s.swap_total) || 0) * 1024 * 1024;
  const diskUsedBytes = (Number(s.disk_used) || 0) * 1024 * 1024;
  const diskTotalBytes = (Number(s.disk_total) || 0) * 1024 * 1024;

  const upMonthly = Number(s.net_tx_monthly);
  const downMonthly = Number(s.net_rx_monthly);
  const hasMonthly = (!isNaN(upMonthly) && upMonthly > 0) ||
                     (!isNaN(downMonthly) && downMonthly > 0) ||
                     Boolean(s.traffic_limit && Number(s.traffic_limit) > 0);

  const netTotalUp = hasMonthly ? (Number(s.net_tx_monthly) || 0) : (Number(s.net_tx) || 0);
  const netTotalDown = hasMonthly ? (Number(s.net_rx_monthly) || 0) : (Number(s.net_rx) || 0);

  const bootTime = Number(s.boot_time || 0);
  const nowMs = Date.now();
  const calculatedUptime = bootTime > 0 ? Math.max(0, Math.floor((nowMs - bootTime) / 1000)) : (Number(s.uptime) || 0);

  return {
    client: s.id,
    time: new Date(lastUpdated || now).toISOString(),
    cpu: Number(s.cpu) || 0,
    gpu: 0,
    ram: ramUsedBytes,
    ram_total: ramTotalBytes,
    swap: swapUsedBytes,
    swap_total: swapTotalBytes,
    load: load1,
    load5: load5,
    load15: load15,
    temp: 0,
    disk: diskUsedBytes,
    disk_total: diskTotalBytes,
    net_in: Number(s.net_in_speed) || 0,
    net_out: Number(s.net_out_speed) || 0,
    net_total_up: netTotalUp,
    net_total_down: netTotalDown,
    process: Number(s.processes) || 0,
    connections: Number(s.tcp_conn) || 0,
    connections_udp: Number(s.udp_conn) || 0,
    online: isOnline,
    uptime: calculatedUptime,
  };
}

const DEFAULT_PING_TASKS: PingTaskFull[] = [
  { id: 1, weight: 1, name: "电信", clients: [], type: "tcp", target: "China Telecom", interval: 60 },
  { id: 2, weight: 2, name: "联通", clients: [], type: "tcp", target: "China Unicom", interval: 60 },
  { id: 3, weight: 3, name: "移动", clients: [], type: "tcp", target: "China Mobile", interval: 60 },
  { id: 4, weight: 4, name: "BGP", clients: [], type: "tcp", target: "BGP", interval: 60 },
];

export class ApiService {
  public useRpc = false;

  enableRpc() {
    this.useRpc = false;
  }

  disableRpc() {
    this.useRpc = false;
  }

  async checkSiteStatus(): Promise<{ status: SiteStatus; publicInfo: PublicInfo | null }> {
    try {
      const res = await fetch("/api/config");
      if (!res.ok) {
        return { status: "public", publicInfo: null };
      }
      const config = await res.json();
      const publicInfo: PublicInfo = {
        sitename: config.site_title || "你还不睡觉",
        description: "Cloudflare Server Monitor with PurCarte-Plus",
        theme: "purcarte-plus",
        theme_settings: config.theme_options || {},
        custom_head: "",
        custom_body: "",
        private_site: !config.is_public,
        disable_password_login: false,
        oauth_enable: false,
        oauth_provider: null,
        record_enabled: true,
        record_preserve_time: 30,
        ping_record_preserve_time: 30,
      };
      return {
        status: config.is_public ? "public" : (config.authorization ? "private-authenticated" : "private-unauthenticated"),
        publicInfo,
      };
    } catch {
      return { status: "public", publicInfo: null };
    }
  }

  async getPublicSettings(): Promise<PublicInfo | null> {
    const { publicInfo } = await this.checkSiteStatus();
    return publicInfo;
  }

  async getVersion(): Promise<{ version: string; hash: string }> {
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const config = await res.json();
        return {
          version: config.version || "2.8.6 Beta5",
          hash: "cfsm",
        };
      }
    } catch {
      // fallback
    }
    return { version: "2.8.6 Beta5", hash: "cfsm" };
  }

  async getNodes(): Promise<NodeData[]> {
    try {
      const res = await fetch("/api/servers");
      if (!res.ok) return [];
      const data = await res.json();
      const servers = Array.isArray(data?.servers) ? data.servers : [];
      rawServersCache = servers;
      serverMapCache.clear();

      const nodes: NodeData[] = [];
      for (const s of servers) {
        serverMapCache.set(s.id, s);
        nodes.push(convertServerToNodeData(s));
        currentStatusMap[s.id] = convertServerToRpcNodeStatus(s);
      }

      // 如果有 ws 实例且在连接，更新订阅列表并广播首屏状态
      if (wsServiceInstance) {
        wsServiceInstance.notify({ ...currentStatusMap });
        wsServiceInstance.updateSubscribedIds();
      }

      return nodes;
    } catch (err) {
      console.error("Failed to fetch nodes from /api/servers:", err);
      return [];
    }
  }

  async getNodeRecentStats(uuid: string): Promise<RpcNodeStatus[]> {
    if (currentStatusMap[uuid]) {
      return [currentStatusMap[uuid]];
    }
    return [];
  }

  async getRecentLoadHistory(uuid: string): Promise<RpcNodeStatus[]> {
    if (currentStatusMap[uuid]) {
      return [currentStatusMap[uuid]];
    }
    return [];
  }

  async getLoadHistory(
    uuid: string,
    hours: number = 24,
    _range?: HistoryQueryRange | null
  ): Promise<LoadHistoryResponse | null> {
    try {
      const res = await fetch(`/api/history/all?id=${encodeURIComponent(uuid)}&hours=${hours || 24}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data)) return null;

      const server = serverMapCache.get(uuid);
      const fallbackMemTotal = server ? (Number(server.ram_total) || 0) * 1024 * 1024 : 0;
      const fallbackDiskTotal = server ? (Number(server.disk_total) || 0) * 1024 * 1024 : 0;
      const fallbackSwapTotal = server ? (Number(server.swap_total) || 0) * 1024 * 1024 : 0;

      const records: HistoryRecord[] = data.map((item: any) => ({
        client: uuid,
        time: new Date(item.timestamp).toISOString(),
        cpu: item.cpu ?? null,
        gpu: null,
        ram: item.ram_used !== undefined ? Number(item.ram_used) * 1024 * 1024 : null,
        ram_total: item.ram_total ? Number(item.ram_total) * 1024 * 1024 : fallbackMemTotal,
        swap: item.swap_used !== undefined ? Number(item.swap_used) * 1024 * 1024 : null,
        swap_total: item.swap_total ? Number(item.swap_total) * 1024 * 1024 : fallbackSwapTotal,
        load: null,
        temp: null,
        disk: item.disk_used !== undefined ? Number(item.disk_used) * 1024 * 1024 : null,
        disk_total: item.disk_total ? Number(item.disk_total) * 1024 * 1024 : fallbackDiskTotal,
        net_in: item.net_in_speed ?? null,
        net_out: item.net_out_speed ?? null,
        net_total_up: item.net_tx ?? null,
        net_total_down: item.net_rx ?? null,
        process: null,
        connections: null,
        connections_udp: null,
      }));

      return {
        count: records.length,
        records,
      };
    } catch (e) {
      console.error("Failed to load history for node:", uuid, e);
      return null;
    }
  }

  async getPingHistory(
    uuid: string,
    _hours: number = 24,
    _range?: HistoryQueryRange | null
  ): Promise<PingHistoryResponse | null> {
    const s = serverMapCache.get(uuid);
    const tasks: PingTask[] = DEFAULT_PING_TASKS.map((t) => ({
      id: t.id,
      interval: t.interval,
      name: t.name,
      loss: 0,
    }));

    if (!s || !Array.isArray(s.ping) || s.ping.length === 0) {
      return { count: 0, records: [], tasks };
    }

    const records: PingHistoryRecord[] = [];
    const pingList = s.ping || [];
    const lossList = s.loss || [];
    const lossMap = new Map<number, any>();
    lossList.forEach((l: any) => lossMap.set(l.ts, l));

    pingList.forEach((p: any) => {
      const l = lossMap.get(p.ts);
      const timeStr = new Date(p.ts).toISOString();

      if (typeof p.ct === "number" && p.ct > 0) {
        records.push({
          task_id: 1,
          time: timeStr,
          value: p.ct,
          loss_ratio: l && typeof l.ct === "number" ? l.ct / 100 : 0,
        });
      }
      if (typeof p.cu === "number" && p.cu > 0) {
        records.push({
          task_id: 2,
          time: timeStr,
          value: p.cu,
          loss_ratio: l && typeof l.cu === "number" ? l.cu / 100 : 0,
        });
      }
      if (typeof p.cm === "number" && p.cm > 0) {
        records.push({
          task_id: 3,
          time: timeStr,
          value: p.cm,
          loss_ratio: l && typeof l.cm === "number" ? l.cm / 100 : 0,
        });
      }
      if (typeof p.bd === "number" && p.bd > 0) {
        records.push({
          task_id: 4,
          time: timeStr,
          value: p.bd,
          loss_ratio: l && typeof l.bd === "number" ? l.bd / 100 : 0,
        });
      }
    });

    return {
      count: records.length,
      records,
      tasks,
    };
  }

  async getPingTasks(): Promise<PingTaskFull[]> {
    return DEFAULT_PING_TASKS;
  }

  async getUserInfo(): Promise<Me | null> {
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const config = await res.json();
        if (config.authorization) {
          return {
            logged_in: true,
            username: "admin",
          };
        }
      }
    } catch {
      // fallback
    }
    return {
      logged_in: false,
      username: "",
    };
  }

  async saveThemeSettings(themeOrSettings: any, maybeSettings?: any): Promise<any> {
    const settings = maybeSettings !== undefined ? maybeSettings : themeOrSettings;
    try {
      await fetch("/api/theme_options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme_options: settings }),
      });
    } catch {
      // ignore
    }
    return settings;
  }

  async getLoadMetricRetentionDays(_publicInfo?: any): Promise<number | null> {
    return 30;
  }

  async getPingMetricRetentionDays(_publicInfo?: any): Promise<number | null> {
    return 30;
  }
}

export class WebSocketService {
  private ws: WebSocket | null = null;
  private listeners = new Set<(data: RpcNodeStatusMap) => void>();
  private reconnectTimer: any = null;
  private pingTimer: any = null;
  private isConnecting = false;
  public useRpc = false;

  enableRpc() {
    this.useRpc = false;
  }

  disableRpcAndFallback() {
    this.useRpc = false;
  }

  subscribe(listener: (data: RpcNodeStatusMap) => void) {
    this.listeners.add(listener);
    if (Object.keys(currentStatusMap).length > 0) {
      try {
        listener({ ...currentStatusMap });
      } catch (e) {
        console.error("Listener error:", e);
      }
    }
    return () => this.listeners.delete(listener);
  }

  notify(data: RpcNodeStatusMap) {
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch (e) {
        console.error("Listener error:", e);
      }
    }
  }

  updateSubscribedIds() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const ids = rawServersCache.map((s) => s.id).filter(Boolean);
      if (ids.length > 0) {
        this.ws.send(JSON.stringify({ type: "subscribe", scope: "all", ids }));
      }
    }
  }

  connect() {
    if (this.ws || this.isConnecting) return;
    this.isConnecting = true;

    try {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${location.host}/api/ws?subscribe=all`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.isConnecting = false;
        this.updateSubscribedIds();

        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
          }
        }, 25000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "batchUpdate" && Array.isArray(msg.updates)) {
            let changed = false;
            for (const update of msg.updates) {
              const sid = update.serverId;
              if (!sid) continue;
              let status = currentStatusMap[sid];
              if (!status) {
                status = {
                  client: sid,
                  time: new Date().toISOString(),
                  cpu: 0,
                  gpu: 0,
                  ram: 0,
                  ram_total: 0,
                  swap: 0,
                  swap_total: 0,
                  load: 0,
                  load5: 0,
                  load15: 0,
                  temp: 0,
                  disk: 0,
                  disk_total: 0,
                  net_in: 0,
                  net_out: 0,
                  net_total_up: 0,
                  net_total_down: 0,
                  process: 0,
                  connections: 0,
                  connections_udp: 0,
                  online: true,
                  uptime: 0,
                };
                currentStatusMap[sid] = status;
              }

              for (const sample of (update.samples || [])) {
                const m = sample.data || sample.payload || sample.metrics;
                if (!m) continue;
                changed = true;
                if (m.cpu !== undefined) status.cpu = Number(m.cpu) || 0;
                if (m.ram_used !== undefined) status.ram = (Number(m.ram_used) || 0) * 1024 * 1024;
                if (m.ram_total !== undefined) status.ram_total = (Number(m.ram_total) || 0) * 1024 * 1024;
                if (m.swap_used !== undefined) status.swap = (Number(m.swap_used) || 0) * 1024 * 1024;
                if (m.swap_total !== undefined) status.swap_total = (Number(m.swap_total) || 0) * 1024 * 1024;
                if (m.disk_used !== undefined) status.disk = (Number(m.disk_used) || 0) * 1024 * 1024;
                if (m.disk_total !== undefined) status.disk_total = (Number(m.disk_total) || 0) * 1024 * 1024;
                if (m.net_in_speed !== undefined) status.net_in = Number(m.net_in_speed) || 0;
                if (m.net_out_speed !== undefined) status.net_out = Number(m.net_out_speed) || 0;
                if (m.net_tx_monthly !== undefined && m.net_tx_monthly !== null) {
                  status.net_total_up = Number(m.net_tx_monthly) || 0;
                } else if (m.net_tx !== undefined && !serverMapCache.get(sid)?.traffic_limit) {
                  status.net_total_up = Number(m.net_tx) || 0;
                }
                if (m.net_rx_monthly !== undefined && m.net_rx_monthly !== null) {
                  status.net_total_down = Number(m.net_rx_monthly) || 0;
                } else if (m.net_rx !== undefined && !serverMapCache.get(sid)?.traffic_limit) {
                  status.net_total_down = Number(m.net_rx) || 0;
                }
                if (m.uptime !== undefined) {
                  status.uptime = Number(m.uptime) || 0;
                } else if (m.boot_time !== undefined) {
                  const bt = Number(m.boot_time) || 0;
                  if (bt > 0) status.uptime = Math.max(0, Math.floor((Date.now() - bt) / 1000));
                }
                if (m.processes !== undefined) status.process = Number(m.processes) || 0;
                if (m.tcp_conn !== undefined) status.connections = Number(m.tcp_conn) || 0;
                if (m.udp_conn !== undefined) status.connections_udp = Number(m.udp_conn) || 0;
                if (m.load_avg) {
                  const parts = String(m.load_avg).trim().split(/\s+/).map(Number);
                  if (!isNaN(parts[0])) status.load = parts[0];
                  if (!isNaN(parts[1])) status.load5 = parts[1];
                  if (!isNaN(parts[2])) status.load15 = parts[2];
                }
                status.online = true;
                status.time = new Date().toISOString();
              }
            }
            if (changed) {
              this.notify({ ...currentStatusMap });
            }
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        this.cleanup();
        this.reconnect();
      };

      ws.onerror = () => {
        this.cleanup();
        this.reconnect();
      };
    } catch {
      this.cleanup();
      this.reconnect();
    }
  }

  private cleanup() {
    this.isConnecting = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ws = null;
  }

  private reconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.listeners.size > 0) {
        this.connect();
      }
    }, 3000);
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
  }
}

export const apiService = new ApiService();

let wsServiceInstance: WebSocketService | null = null;

export function getWsService(): WebSocketService {
  if (!wsServiceInstance) {
    wsServiceInstance = new WebSocketService();
  }
  return wsServiceInstance;
}
