import React, { useState, useEffect, useMemo, useRef } from "react";
import { Loader2, CheckSquare, X, Check, RefreshCw, Search, ChevronDown, Sparkles } from "lucide-react";
import { PageLayout } from "../../components/PageLayout";
import { StatusBadge } from "../../components/StatusBadge";
import { MetricCard } from "../../components/MetricCard";
import { Progress } from "../../components/ui/progress";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../components/ui/tabs";
import { useNavigate } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import type { CollectorJob } from "./collectorTypes";
import { authFetch } from "../../lib/authFetch";
import { useRealtimeData } from "../../hooks/useRealtimeData";
import { toast } from "../../lib/toast";
import { supabase } from "../../lib/supabaseClient";

// Lazy-load the map to avoid importing Leaflet CSS globally
const BinLocatorMap = React.lazy(() =>
  import("../../components/BinLocatorMap").then((m) => ({
    default: m.BinLocatorMap,
  })),
);
const KNUST_FACILITIES = [
  {
    id: "fac-sci",
    name: "College of Science",
    region: "KNUST",
    coords: [6.6735, -1.5658] as [number, number],
  },
  {
    id: "fac-pharm",
    name: "College of Pharmacy",
    region: "KNUST",
    coords: [6.6786, -1.5711] as [number, number],
  },
  {
    id: "fac-eng",
    name: "College of Engineering",
    region: "KNUST",
    coords: [6.6732, -1.5674] as [number, number],
  },
];

interface OfflineJobAction {
  id: string;
  jobId: string;
  status: "In Transit" | "Completed";
  collectorId?: string;
  timestamp: number;
}

const getOfflineQueue = (): OfflineJobAction[] => {
  try {
    const raw = localStorage.getItem("smartsort_offline_job_queue");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const saveOfflineQueue = (queue: OfflineJobAction[]) => {
  try {
    localStorage.setItem("smartsort_offline_job_queue", JSON.stringify(queue));
    window.dispatchEvent(new Event("smartsort_offline_queue_updated"));
  } catch (err) {
    console.warn("Failed to persist offline queue:", err);
  }
};

const queueOfflineAction = (action: Omit<OfflineJobAction, "id" | "timestamp">) => {
  const queue = getOfflineQueue();
  const existingIdx = queue.findIndex((item) => item.jobId === action.jobId);
  const newItem: OfflineJobAction = {
    ...action,
    id: `queue_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: Date.now(),
  };
  if (existingIdx >= 0) {
    queue[existingIdx] = newItem;
  } else {
    queue.push(newItem);
  }
  saveOfflineQueue(queue);
};

export default function CollectorDashboard() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<
    "my_jobs" | "available_jobs" | "map_view"
  >("available_jobs");
  const [selectedFacilityId, setSelectedFacilityId] = useState<string>("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [facilities, setFacilities] = useState(KNUST_FACILITIES);
  const [searchQuery, setSearchQuery] = useState("");
  const [urgencyFilter, setUrgencyFilter] = useState<"all" | "Critical" | "High" | "Normal">("all");

  const [optimisticOverrides, setOptimisticOverrides] = useState<Record<string, any>>({});
  const [offlineQueueCount, setOfflineQueueCount] = useState<number>(() => getOfflineQueue().length);

  const [myCollectorId, setMyCollectorId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<{
    id: string;
    authId?: string;
    name?: string;
    email?: string;
    role?: string;
  } | null>(null);

  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL ?? "http://localhost:5000";

  useEffect(() => {
    const updateCount = () => setOfflineQueueCount(getOfflineQueue().length);
    window.addEventListener("smartsort_offline_queue_updated", updateCount);
    window.addEventListener("storage", updateCount);
    return () => {
      window.removeEventListener("smartsort_offline_queue_updated", updateCount);
      window.removeEventListener("storage", updateCount);
    };
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setMyCollectorId(data.user.id);
      }
    });

    authFetch(`${baseUrl}/api/users/me`)
      .then(async (res) => {
        if (res.ok) {
          const profile = await res.json();
          setCurrentUser(profile);
        }
      })
      .catch((err) => console.warn("Failed to fetch user profile:", err));
  }, [baseUrl]);

  const fetchJobs = async () => {
    const queryParams = new URLSearchParams({ limit: "100" });
    if (selectedFacilityId) queryParams.set("facilityId", selectedFacilityId);
    const url = `${baseUrl}/api/jobs?${queryParams.toString()}`;
    const response = await authFetch(url);
    if (!response.ok) throw new Error("Failed to fetch jobs");
    const json = await response.json();
    return json.data || [];
  };

  const {
    data: fetchedJobs,
    isLoading: jobsLoading,
    refresh: refreshJobs,
  } = useRealtimeData<any[]>(fetchJobs, { tables: ["CollectionJob", "Device"] });

  useEffect(() => {
    refreshJobs().catch(console.error);
  }, [selectedFacilityId]);

  const jobs = useMemo(() => {
    if (!fetchedJobs || !Array.isArray(fetchedJobs)) return [];
    return fetchedJobs.map((rawJob: any) => {
      const override = optimisticOverrides[rawJob.id] || {};
      const job = { ...rawJob, ...override };

      const assignedTo = job.assignedTo ? String(job.assignedTo).toLowerCase() : "";
      const assignedId = job.assignedToId ? String(job.assignedToId) : "";
      const assignedAuthId = job.assignedToAuthId ? String(job.assignedToAuthId) : "";
      const assignedEmail = job.assignedToEmail ? String(job.assignedToEmail).toLowerCase() : "";

      const myId = myCollectorId || "";
      const currentUserId = currentUser?.id || "";
      const currentUserAuthId = currentUser?.authId || "";
      const currentUserName = currentUser?.name ? currentUser.name.toLowerCase() : "";
      const currentUserEmail = currentUser?.email ? currentUser.email.toLowerCase() : "";

      const matchesId = Boolean(
        (myId && (assignedId === myId || assignedAuthId === myId)) ||
        (currentUserId && assignedId === currentUserId) ||
        (currentUserAuthId && (assignedAuthId === currentUserAuthId || assignedId === currentUserAuthId))
      );

      const matchesName = Boolean(
        currentUserName && assignedTo &&
        (assignedTo.includes(currentUserName) || currentUserName.includes(assignedTo))
      );

      const matchesEmail = Boolean(
        currentUserEmail && assignedEmail &&
        assignedEmail === currentUserEmail
      );

      const isKwameDemo = Boolean(
        (currentUserEmail.includes("testcollector") || currentUserName.includes("kwame")) &&
        assignedTo.includes("kwame")
      );

      const isAssigned = matchesId || matchesName || matchesEmail || isKwameDemo || Boolean(override.isAssignedToMe);

      const rawLocation = job.location;
      const cleanLocation =
        rawLocation &&
        rawLocation !== "Unknown Location" &&
        rawLocation !== "Unknown location"
          ? rawLocation
          : "College of Science";

      return {
        ...job,
        location: cleanLocation,
        zone: cleanLocation,
        isAssignedToMe: isAssigned,
      };
    });
  }, [fetchedJobs, myCollectorId, currentUser, optimisticOverrides]);

  // Track job assignment states to accurately trigger toast notifications
  const isFirstLoadRef = useRef(true);
  const prevAssignedJobIdsRef = useRef<Set<string>>(new Set());
  const prevAvailableJobIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!jobs) return;

    const currentAssignedIds = new Set(jobs.filter((j: any) => j.isAssignedToMe).map((j: any) => j.id));
    const currentAvailableIds = new Set(jobs.filter((j: any) => !j.isAssignedToMe).map((j: any) => j.id));

    if (isFirstLoadRef.current) {
      if (jobs.length > 0) {
        isFirstLoadRef.current = false;
        prevAssignedJobIdsRef.current = currentAssignedIds;
        prevAvailableJobIdsRef.current = currentAvailableIds;
      }
      return;
    }

    // Find jobs that just got assigned to me (either brand new or moved from available to assigned)
    const newlyAssignedJobs = jobs.filter((j: any) => j.isAssignedToMe && !prevAssignedJobIdsRef.current.has(j.id));
    for (const job of newlyAssignedJobs) {
      const isUrgent = job.urgency === "Critical" || (job.fill && job.fill >= 90);
      const toastFn = isUrgent ? toast.error : toast.warning;
      const loc = job.location || "College of Science";
      const fillPct = job.fill ?? 85;

      toastFn(
        `🚛 New Collection Task Assigned: ${loc}`,
        {
          id: `collector-task-assigned-${job.id}`,
          duration: 9000,
          description: `${job.device || "Unit"} (${fillPct}% capacity, ${job.urgency || "High"} priority) has been assigned to you. Tap to view route.`,
          action: {
            label: "Open Task",
            onClick: () => {
              setActiveTab("my_jobs");
              setSelectedJobId(job.id);
            },
          },
        }
      );

      // Auto-switch to My Tasks tab and focus on this job
      setActiveTab("my_jobs");
      setSelectedJobId(job.id);
    }

    // Find jobs that just became available (brand new auto-scheduled jobs)
    const newlyAvailableJobs = jobs.filter((j: any) => !j.isAssignedToMe && !prevAvailableJobIdsRef.current.has(j.id) && !prevAssignedJobIdsRef.current.has(j.id));
    for (const job of newlyAvailableJobs) {
      const loc = job.location || "College of Science";
      const fillPct = job.fill ?? 80;

      toast.info(
        `📦 New Bin Over Capacity: ${loc}`,
        {
          id: `collector-new-available-${job.id}`,
          duration: 8000,
          description: `${job.device || "Unit"} reached ${fillPct}% capacity and is awaiting collection.`,
          action: {
            label: "Claim Bin",
            onClick: () => {
              setActiveTab("available_jobs");
              setSelectedJobId(job.id);
            },
          },
        }
      );
    }

    prevAssignedJobIdsRef.current = currentAssignedIds;
    prevAvailableJobIdsRef.current = currentAvailableIds;
  }, [jobs]);

  // Fetch facilities from API to stay synced with Admin Dashboard if online
  useEffect(() => {
    const baseUrl =
      (import.meta as any).env?.VITE_API_BASE_URL ?? "http://localhost:5000";
    authFetch(`${baseUrl}/api/admin/facilities`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          const mapped = data.map((f: any) => ({
            id: f.id,
            name: f.name,
            region: f.region || "KNUST",
            coords: [f.latitude, f.longitude] as [number, number],
          }));
          setFacilities(mapped);
        }
      })
      .catch(() => {});
  }, [baseUrl]);

  const currentFacility = useMemo(() => {
    return (
      facilities.find((f) => f.id === selectedFacilityId) ||
      facilities[0] ||
      {
        id: "fac-sci",
        name: "College of Science",
        region: "KNUST",
        coords: [6.6735, -1.5658],
      }
    );
  }, [facilities, selectedFacilityId]);

  const [isOptimized, setIsOptimized] = useState(true);
  const [isOffline, setIsOffline] = useState<boolean>(!navigator.onLine);
  const [remindJobId, setRemindJobId] = useState<string | null>(null);

  // Synchronize queued offline job actions with backend when connection is active
  const syncOfflineQueue = async () => {
    const queue = getOfflineQueue();
    if (queue.length === 0) return;

    let syncedCount = 0;
    const remainingQueue: OfflineJobAction[] = [];

    for (const item of queue) {
      try {
        const payload: any = { status: item.status };
        if (item.collectorId) payload.collectorId = item.collectorId;

        const res = await authFetch(`${baseUrl}/api/jobs/${item.jobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          syncedCount++;
        } else {
          remainingQueue.push(item);
        }
      } catch (err) {
        console.warn(`Failed to sync queued action for job ${item.jobId}:`, err);
        remainingQueue.push(item);
      }
    }

    saveOfflineQueue(remainingQueue);
    setOfflineQueueCount(remainingQueue.length);

    if (syncedCount > 0) {
      toast.success(`Synced ${syncedCount} offline task update${syncedCount > 1 ? "s" : ""} to server!`);
      setOptimisticOverrides({});
      await refreshJobs();
    }
  };

  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false);
      syncOfflineQueue();
    };
    const handleOffline = () => {
      setIsOffline(true);
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    if (navigator.onLine) {
      syncOfflineQueue();
    }

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [baseUrl]);

  // Sorting assignments: Critical first, then High, then Normal, then by fill level descending
  const getOptimizedRoute = (activeJobs: typeof jobs) => {
    const urgencyWeight = { Critical: 3, Urgent: 3, High: 2, Medium: 1, Normal: 0 };
    return [...activeJobs]
      .filter((j) => j.status !== "Completed")
      .sort((a, b) => {
        const aW = urgencyWeight[a.urgency as keyof typeof urgencyWeight] || 0;
        const bW = urgencyWeight[b.urgency as keyof typeof urgencyWeight] || 0;
        if (aW !== bW) return bW - aW;
        return b.fill - a.fill;
      });
  };

  const isJobAvailable = (j: any) =>
    !j.isAssignedToMe &&
    j.status === "Pending" &&
    (!j.assignedToId || j.assignedToId === "Unassigned" || !j.assignedTo);

  const handleClaimJob = async (id: string) => {
    // Haptic feedback for tactile feel on mobile devices
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try { navigator.vibrate([40, 30, 40]); } catch {}
    }

    if (!myCollectorId) {
      toast.error("Collector ID not found. Please log in again.");
      return;
    }

    // Immediate optimistic override for instant feedback
    setOptimisticOverrides((prev) => ({
      ...prev,
      [id]: {
        status: "In Transit",
        assignedToId: myCollectorId,
        assignedTo: currentUser?.name || "Me",
        isAssignedToMe: true,
      },
    }));

    if (!navigator.onLine) {
      queueOfflineAction({
        jobId: id,
        status: "In Transit",
        collectorId: myCollectorId,
      });
      toast.info("Offline: Task claimed and queued for automatic sync.");
      setActiveTab("my_jobs");
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectorId: myCollectorId, status: "In Transit" }),
      });
      if (response.ok) {
        toast.success("Job claimed and moved to My Tasks!");
        await refreshJobs();
        setActiveTab("my_jobs");
      } else {
        const errJson = await response.json().catch(() => ({}));
        toast.error(errJson.message || "Failed to claim job");
        setOptimisticOverrides((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    } catch (e) {
      console.warn("Network error claiming job, queueing offline:", e);
      queueOfflineAction({
        jobId: id,
        status: "In Transit",
        collectorId: myCollectorId,
      });
      toast.info("Connection lost: Task claimed and queued for sync.");
      setActiveTab("my_jobs");
    }
  };

  const handleCompleteJob = async (id: string) => {
    // Haptic feedback for task completion
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try { navigator.vibrate([60, 40, 60]); } catch {}
    }

    // Immediate optimistic update
    setOptimisticOverrides((prev) => ({
      ...prev,
      [id]: {
        status: "Completed",
      },
    }));

    if (!navigator.onLine) {
      queueOfflineAction({
        jobId: id,
        status: "Completed",
      });
      toast.success("Task marked complete offline! Queued for sync.");
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "Completed" }),
      });
      if (response.ok) {
        toast.success("Job marked as completed!");
        await refreshJobs();
      } else {
        const errJson = await response.json().catch(() => ({}));
        toast.error(errJson.message || "Failed to complete job");
        setOptimisticOverrides((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    } catch (e) {
      console.warn("Network error completing job, queueing offline:", e);
      queueOfflineAction({
        jobId: id,
        status: "Completed",
      });
      toast.info("Connection lost: Task completed offline and queued for sync.");
    }
  };

  // Get active assignments (assigned to me and not completed)
  const activeAssignments = jobs.filter(
    (j) => j.isAssignedToMe && j.status !== "Completed",
  );
  const completedToday = jobs.filter(
    (j) => j.isAssignedToMe && j.status === "Completed",
  ).length;
  const totalMyAssignments = jobs.filter((j) => j.isAssignedToMe).length;

  // Calculate quota percentage
  const quotaPercentage =
    totalMyAssignments > 0
      ? Math.round((completedToday / totalMyAssignments) * 100)
      : 0;

  // Create optimized sequence list
  const optimizedRoute = getOptimizedRoute(activeAssignments);

  // Determine which jobs to display in lists
  const displayedJobs = (() => {
    let baseList = jobs.filter((job) =>
      activeTab === "my_jobs"
        ? job.isAssignedToMe
        : isJobAvailable(job),
    );
    if (activeTab === "my_jobs" && isOptimized) {
      const completed = baseList.filter((j) => j.status === "Completed");
      baseList = [...optimizedRoute, ...completed];
    }
    return baseList.filter((job) => {
      const q = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !q ||
        (job.location && job.location.toLowerCase().includes(q)) ||
        (job.device && job.device.toLowerCase().includes(q)) ||
        (job.zone && job.zone.toLowerCase().includes(q));

      const matchesUrgency =
        urgencyFilter === "all" || job.urgency === urgencyFilter;

      return matchesSearch && matchesUrgency;
    });
  })();

  return (
    <PageLayout
      title="Collector Dashboard"
      description={`Welcome back, ${currentUser?.name || "Kwame"}. Here are your tasks for today.`}
      hideAlertsIcon={true}
    >
      {/* Quota & Facility Location Sync Bar */}
      <div className="flex flex-col md:flex-row items-slate-200 md:items-center justify-between gap-4 bg-card border border-border rounded-xl p-5 mb-6 shadow-sm">
        <div className="flex items-center gap-4">
          {/* Circular Quota Progress Ring */}
          <div className="relative h-14 w-14 flex items-center justify-center shrink-0">
            <svg className="h-full w-full transform -rotate-90">
              <circle
                cx="28"
                cy="28"
                r="24"
                strokeWidth="4"
                stroke="currentColor"
                className="text-slate-100 dark:text-slate-800"
                fill="transparent"
              />
              <circle
                cx="28"
                cy="28"
                r="24"
                strokeWidth="4"
                strokeDasharray={150.7}
                strokeDashoffset={150.7 - (150.7 * quotaPercentage) / 100}
                strokeLinecap="round"
                stroke="currentColor"
                className="text-[#006c49] dark:text-emerald-400 transition-all duration-1000"
                fill="transparent"
              />
            </svg>
            <span className="absolute text-[11px] font-black text-foreground dark:text-white">
              {quotaPercentage}%
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-foreground dark:text-white">
                Daily Quota Progress
              </h2>
              {quotaPercentage === 100 ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <Sparkles className="w-2.5 h-2.5" /> Target Met
                </span>
              ) : quotaPercentage >= 50 ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/20">
                  On Track
                </span>
              ) : (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                  In Progress
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Completed {completedToday} of {totalMyAssignments} assigned bins
              today.
            </p>
          </div>
        </div>

        {/* Collector Assigned Facility Location Selector */}
        <div className="flex items-center gap-3 flex-wrap md:flex-nowrap">
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5">
              Assigned Facility
            </span>
            <div className="relative">
              <select
                value={selectedFacilityId}
                onChange={(e) => setSelectedFacilityId(e.target.value)}
                className="h-9 pl-3 pr-8 bg-background border border-border rounded-lg text-xs font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 hover:border-foreground/30 transition-all cursor-pointer appearance-none shadow-2xs"
              >
                <option value="">🌐 All Facilities & Zones</option>
                {facilities.map((fac) => (
                  <option key={fac.id} value={fac.id}>
                    📍 {fac.name} ({fac.region})
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground">
                <ChevronDown className="w-3.5 h-3.5" />
              </div>
            </div>
          </div>

          {/* Quick Refresh Button */}
          <button
            onClick={() => {
              refreshJobs();
              toast.info("Refreshed collection tasks");
            }}
            className="h-9 px-3 mt-auto bg-background border border-border rounded-lg text-xs font-bold text-foreground hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-[0.98] transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs"
            title="Refresh collection jobs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${jobsLoading ? "animate-spin text-primary" : ""}`} />
            <span>Refresh</span>
          </button>

          {/* Offline Sync Mode Control */}
          <div className="flex items-center gap-2 border-l border-border pl-3 ml-1">
            <div className="flex flex-col text-right">
              <span className="text-xs font-bold text-foreground dark:text-white flex items-center gap-1.5 justify-end">
                <span
                  className={`h-2 w-2 rounded-full ${isOffline ? "bg-amber-500 animate-pulse" : "bg-emerald-500 animate-ping"}`}
                />
                {isOffline ? "Local Cache" : "Real-time Sync"}
              </span>
            </div>
            <button
              onClick={() => setIsOffline(!isOffline)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                isOffline ? "bg-amber-500" : "bg-primary"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  isOffline ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Offline Status & Pending Queue Alert */}
      {(isOffline || offlineQueueCount > 0) && (
        <div
          className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl mb-6 text-xs font-semibold shadow-sm border transition-all ${
            isOffline
              ? "bg-amber-500/10 border-amber-500/30 text-amber-900 dark:text-amber-200"
              : "bg-emerald-500/10 border-emerald-500/30 text-emerald-900 dark:text-emerald-200"
          }`}
        >
          <div className="flex items-center gap-2.5">
            {isOffline ? (
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
            ) : (
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0" />
            )}
            <span>
              {isOffline
                ? `Offline Field Mode • ${offlineQueueCount} task update${offlineQueueCount === 1 ? "" : "s"} cached locally. Will sync when reconnected.`
                : `${offlineQueueCount} queued task update${offlineQueueCount === 1 ? "" : "s"} ready to synchronize.`}
            </span>
          </div>
          {!isOffline && offlineQueueCount > 0 && (
            <button
              onClick={syncOfflineQueue}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] text-white font-bold text-xs transition-all cursor-pointer shadow-xs"
            >
              Sync Now ({offlineQueueCount})
            </button>
          )}
        </div>
      )}

      {/* Map-First Split Layout */}
      <div className="relative w-full h-[650px] border border-border rounded-2xl overflow-hidden shadow-md flex flex-col md:flex-row bg-card">
        {/* Left Side: Floating Panel HUD */}
        <div className="w-full md:w-[380px] bg-card border-b md:border-b-0 md:border-r border-border flex flex-col z-20 shrink-0 h-[280px] md:h-full overflow-hidden">
          {/* Tabs Selector Header */}
          <div className="bg-slate-50 dark:bg-secondary border-b border-border flex p-1 gap-1">
            <button
              onClick={() => setActiveTab("available_jobs")}
              className={`flex-1 py-2.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                activeTab === "available_jobs"
                  ? "bg-white dark:bg-card text-[#006c49] dark:text-emerald-400 shadow-sm border border-border/50"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Available Bins ({jobs.filter(isJobAvailable).length})
            </button>
            <button
              onClick={() => setActiveTab("my_jobs")}
              className={`flex-1 py-2.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                activeTab === "my_jobs"
                  ? "bg-white dark:bg-card text-[#006c49] dark:text-emerald-400 shadow-sm border border-border/50"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              My Tasks (
              {
                jobs.filter(
                  (j: any) => j.isAssignedToMe && j.status !== "Completed",
                ).length
              }
              )
            </button>
          </div>

          {/* Quick Search & Urgency Filter Bar */}
          <div className="p-2.5 border-b border-border bg-card/60 flex flex-col gap-2 shrink-0">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Filter by bin or building..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-7 py-1.5 bg-background border border-border rounded-lg text-xs placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs p-1"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {(["all", "Critical", "High", "Normal"] as const).map((urg) => (
                <button
                  key={urg}
                  onClick={() => setUrgencyFilter(urg)}
                  className={`px-2 py-0.5 rounded-md text-[10px] font-bold transition-all cursor-pointer active:scale-95 ${
                    urgencyFilter === urg
                      ? urg === "Critical"
                        ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30"
                        : urg === "High"
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30"
                          : urg === "Normal"
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30"
                            : "bg-primary text-white"
                      : "text-muted-foreground hover:bg-muted/50 border border-transparent"
                  }`}
                >
                  {urg === "all" ? "All" : urg}
                </button>
              ))}
            </div>
          </div>

          {/* Job List Scrollable */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            {displayedJobs.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-xs flex flex-col items-center gap-1">
                <span>No active jobs match your filters.</span>
                {(searchQuery || urgencyFilter !== "all") && (
                  <button
                    onClick={() => {
                      setSearchQuery("");
                      setUrgencyFilter("all");
                    }}
                    className="text-primary hover:underline text-[11px] font-semibold mt-1"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              displayedJobs.map((job: any) => {
                const isSelected = selectedJobId === job.id;
                return (
                  <div
                    key={job.id}
                    onClick={() => setSelectedJobId(job.id)}
                    className={`border rounded-xl p-3 bg-card flex flex-col gap-2 transition-all cursor-pointer ${
                      isSelected
                        ? "border-[#006c49] dark:border-emerald-400 ring-2 ring-[#006c49]/20 shadow-sm"
                        : "border-border/80 dark:border-border hover:border-[#0284c7]"
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <span className="text-xs font-extrabold text-foreground dark:text-white block">
                          {job.location}
                        </span>
                        <span className="text-[9px] font-mono text-slate-400 dark:text-slate-500">
                          {job.device} • {job.zone}
                        </span>
                      </div>
                      <StatusBadge
                        label={job.urgency}
                        variant={
                          job.urgency === "Critical"
                            ? "danger"
                            : job.urgency === "High"
                              ? "warning"
                              : "success"
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3 mt-1">
                      <div className="flex items-center gap-1.5">
                        <Progress
                          value={job.fill}
                          className={`w-12 h-1 bg-muted ${
                            job.fill >= 80
                              ? "[&>[data-slot=progress-indicator]]:bg-rose-500"
                              : job.fill >= 50
                                ? "[&>[data-slot=progress-indicator]]:bg-amber-500"
                                : "[&>[data-slot=progress-indicator]]:bg-emerald-500"
                          }`}
                        />
                        <span
                          className={`text-[9px] font-bold ${
                            job.fill >= 80
                              ? "text-rose-600 dark:text-rose-400"
                              : job.fill >= 50
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-emerald-600 dark:text-emerald-400"
                          }`}
                        >
                          {job.fill}%
                        </span>
                      </div>

                      <div className="flex items-center gap-1">
                        {activeTab === "available_jobs" ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleClaimJob(job.id);
                            }}
                            className="px-2.5 py-1 bg-primary text-white text-[10px] font-bold rounded-md hover:bg-primary/90 active:scale-[0.98] transition-all cursor-pointer"
                          >
                            Claim
                          </button>
                        ) : job.status !== "Completed" ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRemindJobId(job.id);
                            }}
                            className="px-2.5 py-1 bg-primary text-white text-[10px] font-bold rounded-md hover:bg-primary/90 active:scale-[0.98] transition-all cursor-pointer"
                          >
                            Mark Done
                          </button>
                        ) : (
                          <span className="text-[10px] text-emerald-500 font-bold">
                            ✓ Done
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Side: Map Canvas backdrop */}
        <div className="flex-1 h-full relative z-10">
          <React.Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm gap-2">
                <Loader2 className="animate-spin w-4 h-4" strokeWidth={2} />
                Loading campus map…
              </div>
            }
          >
            <BinLocatorMap
              jobs={displayedJobs}
              facilities={facilities}
              facilityName={currentFacility.name}
              facilityCoords={currentFacility.coords}
              activeTab={activeTab}
              selectedJobId={selectedJobId}
              onSelectJob={(job) => setSelectedJobId(job.id)}
              onClaimJob={handleClaimJob}
              onCompleteJob={(id) => setRemindJobId(id)}
            />
          </React.Suspense>
        </div>
      </div>

      <AnimatePresence>
        {remindJobId &&
          (() => {
            const job = jobs.find((j: any) => j.id === remindJobId);
            if (!job) return null;
            const checklist = [
              "Bin has been physically emptied",
              "Area around the bin is clean",
              "Bin lid is properly closed",
              "Device is functioning normally",
            ];
            return (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-card/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4"
              >
                <motion.div
                  initial={{ y: 60, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 60, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 28 }}
                  className="bg-card border border-border rounded-xl w-full max-w-sm p-6 shadow-md flex flex-col gap-5"
                >
                  {/* Header */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-primary/10 text-[#006c49] dark:text-emerald-400 flex items-center justify-center shrink-0">
                        <CheckSquare className="w-5 h-5" strokeWidth={2.5} />
                      </div>
                      <div>
                        <h3 className="text-sm font-black text-foreground dark:text-white">
                          Task Completion Checklist
                        </h3>
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                          {job.location}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setRemindJobId(null)}
                      className="text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors mt-0.5"
                    >
                      <X className="w-[18px] h-[18px]" strokeWidth={2.5} />
                    </button>
                  </div>

                  {/* Job details strip */}
                  <div className="bg-slate-50 dark:bg-secondary rounded-xl px-4 py-3 flex justify-between items-center border border-slate-100 dark:border-border">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      Device
                    </span>
                    <span className="text-[11px] font-mono font-bold text-foreground dark:text-white">
                      {job.device}
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      Fill
                    </span>
                    <span className="text-[11px] font-bold text-[#ba1a1a] dark:text-red-400">
                      {job.fill}%
                    </span>
                  </div>

                  {/* Reminder checklist */}
                  <div className="flex flex-col gap-2.5">
                    <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                      Before marking complete, confirm:
                    </p>
                    {checklist.map((item, i) => (
                      <div key={i} className="flex items-start gap-2.5">
                        <div className="mt-0.5 h-4 w-4 rounded border border-[#006c49] dark:border-emerald-500 bg-primary/10 flex items-center justify-center shrink-0">
                          <Check
                            className="w-[9px] h-[9px] text-[#006c49] dark:text-emerald-400"
                            strokeWidth={3.5}
                          />
                        </div>
                        <span className="text-xs text-foreground dark:text-muted-foreground">
                          {item}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Action buttons */}
                  <div className="flex gap-3 pt-1 border-t border-slate-100 dark:border-[#0f2942]">
                    <button
                      onClick={() => setRemindJobId(null)}
                      className="flex-1 py-2.5 border border-slate-200 dark:border-border text-slate-500 dark:text-slate-400 text-xs font-bold rounded-xl hover:bg-slate-50 dark:hover:bg-secondary active:scale-[0.98] transition-all cursor-pointer"
                    >
                      Not Yet
                    </button>
                    <button
                      onClick={() => {
                        handleCompleteJob(job.id);
                        setRemindJobId(null);
                      }}
                      className="flex-1 py-2.5 bg-primary text-white text-xs font-bold rounded-xl hover:bg-primary/90 active:scale-[0.98] transition-all shadow-md flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Check className="w-[13px] h-[13px]" strokeWidth={3} />
                      Confirm Complete
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            );
          })()}
      </AnimatePresence>
    </PageLayout>
  );
}
