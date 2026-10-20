import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Warehouse,
  Smartphone,
  Activity,
  Truck,
  Search,
  X,
  ChevronRight,
  Navigation,
  AlertTriangle,
  CheckCircle2,
  Filter,
  Zap,
} from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { Link } from "react-router";
import { PageLayout } from "../../components/PageLayout";
import { MetricCard } from "../../components/MetricCard";
import { authFetch } from "../../lib/authFetch";
import { toast } from "../../lib/toast";
import {
  MapLibreMap,
  MapPin,
  VehicleTelemetry,
} from "../../components/MapLibreMap";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../../components/ui/table";
import { Progress } from "../../components/ui/progress";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface Facility {
  id: string;
  name: string;
  region: string;
  status: string;
  latitude: number;
  longitude: number;
  deviceCount: number;
  activeDevices: number;
  averageFill: number;
  pendingTonnage: number;
  alertCount: number;
}

interface GlobalMetrics {
  facilitiesCount: number;
  activeFacilitiesCount: number;
  deviceStatus: string;
  totalItemsSorted: string;
  recyclingRate: string;
  contaminationRate: string;
  totalPendingTonnage: number;
  criticalAlertsCount: number;
}

interface BulkJob {
  id: string;
  facilityId: string;
  facility: { name: string };
  status: string;
  tonnage: number;
  collectorName: string;
  scheduledFor: string | null;
  completedAt: string | null;
  createdAt: string;
}

// Depots for routing
const KNUST_DEPOT: [number, number] = [6.673, -1.565];

const STREET_ROUTES: Record<string, [number, number][]> = {
  "College of Science": [
    KNUST_DEPOT,
    [6.673, -1.5658],
    [6.6735, -1.5658],
    [6.6735, -1.5667],
    [6.673, -1.5667],
  ],
  "College of Pharmacy": [
    KNUST_DEPOT,
    [6.673, -1.568],
    [6.676, -1.568],
    [6.676, -1.571],
    [6.6786, -1.5711],
  ],
  "College of Engineering": [
    KNUST_DEPOT,
    [6.671, -1.565],
    [6.671, -1.5674],
    [6.6732, -1.5674],
  ],
};

function useLiveTruckPositions(
  activeDispatches: BulkJob[],
  facilities: Facility[],
) {
  const [truckPositions, setTruckPositions] = useState<
    Array<{
      id: string;
      name: string;
      pos: [number, number];
      route: [number, number][];
      targetIndex: number;
      rotation: number;
    }>
  >([]);

  const dispatchKey = useMemo(
    () =>
      activeDispatches
        .map((d) => `${d.id}:${d.facilityId}:${d.collectorName}`)
        .join("|"),
    [activeDispatches],
  );

  useEffect(() => {
    setTruckPositions((prev) => {
      let changed = prev.length !== activeDispatches.length;
      const next = activeDispatches.map((j) => {
        const existing = prev.find((t) => t.id === j.id);
        if (existing) return existing;

        changed = true;
        const facility = facilities.find((f) => f.id === j.facilityId);
        const defaultRoute: [number, number][] = [
          KNUST_DEPOT,
          [
            facility ? facility.latitude : 6.673,
            facility ? facility.longitude : -1.566,
          ],
        ];
        const route = facility
          ? STREET_ROUTES[facility.name] || defaultRoute
          : defaultRoute;

        return {
          id: j.id,
          name: j.collectorName,
          pos: [...KNUST_DEPOT] as [number, number],
          route,
          targetIndex: 1,
          rotation: 0,
        };
      });

      return changed ? next : prev;
    });
  }, [dispatchKey, facilities]);

  useEffect(() => {
    const hasActiveTrucks = truckPositions.some(
      (t) => t.targetIndex < t.route.length,
    );
    if (!hasActiveTrucks) return;

    const timer = setInterval(() => {
      setTruckPositions((prevTrucks) => {
        let hasMovingTrucks = false;
        const updated = prevTrucks.map((truck) => {
          if (truck.targetIndex >= truck.route.length) return truck;

          hasMovingTrucks = true;
          const targetWaypoint = truck.route[truck.targetIndex];
          const targetLat = targetWaypoint[0];
          const targetLng = targetWaypoint[1];

          const stepSize = 0.000015;
          const deltaLat = targetLat - truck.pos[0];
          const deltaLng = targetLng - truck.pos[1];
          const distance = Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng);
          const angle = Math.atan2(deltaLng, deltaLat) * (180 / Math.PI);

          if (distance < stepSize) {
            return {
              ...truck,
              pos: [targetLat, targetLng] as [number, number],
              targetIndex: truck.targetIndex + 1,
              rotation: angle,
            };
          }

          const ratio = stepSize / distance;
          return {
            ...truck,
            pos: [
              truck.pos[0] + deltaLat * ratio,
              truck.pos[1] + deltaLng * ratio,
            ] as [number, number],
            rotation: angle,
          };
        });

        return hasMovingTrucks ? updated : prevTrucks;
      });
    }, 30);

    return () => clearInterval(timer);
  }, [truckPositions]);

  return truckPositions;
}

export default function AdminDashboard() {
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [metrics, setMetrics] = useState<GlobalMetrics>({
    facilitiesCount: 0,
    activeFacilitiesCount: 0,
    deviceStatus: "0/0",
    totalItemsSorted: "0",
    recyclingRate: "0%",
    contaminationRate: "0%",
    totalPendingTonnage: 0,
    criticalAlertsCount: 0,
  });
  const [bulkJobs, setBulkJobs] = useState<BulkJob[]>([]);
  const [loading, setLoading] = useState(true);

  // Dispatch Form States
  const [selectedFacilityId, setSelectedFacilityId] = useState("");
  const [tonnageInput, setTonnageInput] = useState("3.0");
  const [selectedCollectorName, setSelectedCollectorName] = useState(
    "Zoomlion Ghana Limited",
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [trackingTruckId, setTrackingTruckId] = useState<string | null>(null);
  const [layerFilter, setLayerFilter] = useState<"all" | "bins" | "facilities">(
    "all",
  );
  const [facilitySearch, setFacilitySearch] = useState("");
  const [facilityFilter, setFacilityFilter] = useState<"all" | "high_fill" | "alerts">("all");

  const handleQuickDispatchFacility = (fac: Facility) => {
    setSelectedFacilityId(fac.id);
    setTonnageInput(Math.max(1.5, fac.pendingTonnage || 2.5).toFixed(1));
    toast.info(`Pre-filled dispatch parameters for ${fac.name}`);
    const el = document.getElementById("dispatch-controller-card");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  const activeDispatches = useMemo(
    () => bulkJobs.filter((j) => j.status === "Dispatched"),
    [bulkJobs],
  );
  const truckPositions = useLiveTruckPositions(activeDispatches, facilities);

  const vehicleTelemetryList: VehicleTelemetry[] = truckPositions.map((t) => ({
    id: t.id,
    label: t.name,
    lat: t.pos[0],
    lng: t.pos[1],
    heading: t.rotation,
    status: "En-Route",
  }));

  const allMapPins: MapPin[] = useMemo(() => {
    const facPins: MapPin[] = facilities.map((fac) => {
      const color =
        fac.pendingTonnage >= 4.0
          ? "#ba1a1a"
          : fac.pendingTonnage >= 2.0
            ? "#f59e0b"
            : "#10b981";

      return {
        id: fac.id,
        lat: fac.latitude,
        lng: fac.longitude,
        title: fac.name,
        subtitle: `${fac.region} • ${fac.pendingTonnage} Tons Pending`,
        urgency: fac.status,
        fill: fac.averageFill,
        type: "facility" as const,
        isFacility: true,
        tonnage: fac.pendingTonnage,
        color,
      };
    });

    // Smart bin pins clustered around facilities
    const binPins: MapPin[] = facilities.flatMap((fac) => {
      const binCount = fac.deviceCount || 4;
      return Array.from({ length: Math.min(binCount, 4) }).map((_, binIdx) => {
        const angle = (binIdx * (360 / Math.min(binCount, 4)) * Math.PI) / 180;
        const radius = 0.0035 + (binIdx % 2) * 0.0015;
        const lat = fac.latitude + Math.sin(angle) * radius;
        const lng = fac.longitude + Math.cos(angle) * radius;
        const fill = Math.min(
          98,
          Math.max(25, fac.averageFill + (binIdx * 11 - 15)),
        );
        const color =
          fill >= 90 ? "#ba1a1a" : fill >= 70 ? "#f59e0b" : "#10b981";

        return {
          id: `BIN-${fac.id.slice(0, 4)}-${binIdx + 1}`,
          lat,
          lng,
          title: `${fac.name} - Bin #${binIdx + 1}`,
          subtitle: `IoT Smart Bin • Fill ${fill}%`,
          urgency: fill >= 90 ? "Critical" : fill >= 70 ? "Warning" : "Normal",
          fill,
          type: "bin" as const,
          isFacility: false,
          color,
        };
      });
    });

    return [...facPins, ...binPins];
  }, [facilities]);

  const filteredPins: MapPin[] = useMemo(() => {
    if (layerFilter === "facilities")
      return allMapPins.filter(
        (p) => p.isFacility === true || p.type === "facility",
      );
    if (layerFilter === "bins")
      return allMapPins.filter(
        (p) => p.isFacility === false || p.type === "bin",
      );
    return allMapPins;
  }, [layerFilter, allMapPins]);

  const filteredFacilities = useMemo(() => {
    return facilities.filter((fac) => {
      const q = facilitySearch.trim().toLowerCase();
      const matchesSearch =
        !q ||
        fac.name.toLowerCase().includes(q) ||
        fac.region.toLowerCase().includes(q);

      const matchesFilter =
        facilityFilter === "all" ||
        (facilityFilter === "high_fill" && fac.averageFill >= 75) ||
        (facilityFilter === "alerts" && fac.alertCount > 0);

      return matchesSearch && matchesFilter;
    });
  }, [facilities, facilitySearch, facilityFilter]);

  const baseUrl =
    (import.meta as any).env?.VITE_API_BASE_URL ?? "http://localhost:5000";

  const loadData = async () => {
    try {
      const [facRes, metRes, jobRes] = await Promise.all([
        authFetch(`${baseUrl}/api/admin/facilities`),
        authFetch(`${baseUrl}/api/admin/global-metrics`),
        authFetch(`${baseUrl}/api/admin/bulk-jobs`),
      ]);

      if (!facRes.ok || !metRes.ok || !jobRes.ok) {
        throw new Error("Failed to load admin telemetry");
      }

      const facData = await facRes.json();
      const metData = await metRes.json();
      const jobData = await jobRes.json();

      setFacilities(facData);
      setMetrics(metData);
      setBulkJobs(jobData);
    } catch (e: any) {
      toast.error(e.message || "Connection error to telemetry server");
    } finally {
      setLoading(false);
    }
  };

  const alertedFacilityTonnagesRef = useRef<Map<string, number>>(new Map());

  // Real-time facility tonnage monitoring: trigger pop-up when threshold reached & truck pickup needed
  useEffect(() => {
    if (!facilities || facilities.length === 0) return;

    // Threshold for municipal heavy truck pickup: 2.5 Tons
    const TONNAGE_PICKUP_THRESHOLD = 2.5;

    for (const fac of facilities) {
      const tonnage = fac.pendingTonnage || 0;
      const prevTonnage = alertedFacilityTonnagesRef.current.get(fac.id) ?? 0;

      // Alert if tonnage is over threshold and either never alerted or has increased
      if (
        tonnage >= TONNAGE_PICKUP_THRESHOLD &&
        (!alertedFacilityTonnagesRef.current.has(fac.id) || tonnage > prevTonnage)
      ) {
        alertedFacilityTonnagesRef.current.set(fac.id, tonnage);

        toast.error(
          `🚛 Facility Tonnage Limit Exceeded: ${fac.name}`,
          {
            id: `facility-tonnage-alert-${fac.id}`,
            duration: 10000,
            description: `${fac.name} (${fac.region}) has reached ${tonnage.toFixed(1)} Tons of accumulated waste and is in urgent need of a heavy truck pickup.`,
            action: {
              label: "Dispatch Truck",
              onClick: () => {
                setSelectedFacilityId(fac.id);
                setTonnageInput(tonnage.toFixed(1));
                const el = document.getElementById("dispatch-controller-card");
                if (el) el.scrollIntoView({ behavior: "smooth" });
              },
            },
          }
        );
      }
    }
  }, [facilities]);

  useEffect(() => {
    loadData();

    // Subscribe to real-time changes on Facility, BulkCollectionJob, and Device tables
    const channel = supabase
      .channel("admin-dashboard-realtime")
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "BulkCollectionJob" },
        () => {
          loadData();
        }
      )
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "Facility" },
        () => {
          loadData();
        }
      )
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "Device" },
        () => {
          loadData();
        }
      )
      .subscribe();

    const interval = setInterval(loadData, 10000); // Polling fallback
    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  const handleDispatchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFacilityId) {
      toast.error("Please select a target facility");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await authFetch(`${baseUrl}/api/admin/bulk-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facilityId: selectedFacilityId,
          tonnage: parseFloat(tonnageInput),
          collectorName: selectedCollectorName,
        }),
      });

      if (!response.ok) throw new Error("Dispatch failed");

      toast.success(`Successfully dispatched ${selectedCollectorName}!`);
      setSelectedFacilityId("");
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Failed to submit collection route");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCompletePickup = async (jobId: string) => {
    try {
      const response = await authFetch(
        `${baseUrl}/api/admin/bulk-jobs/${jobId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "Completed" }),
        },
      );

      if (!response.ok) throw new Error("Failed to complete pickup");

      toast.success("Trash collected and facility tonnage cleared!");
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Failed to update bulk route");
    }
  };

  const handleTransitPickup = async (jobId: string) => {
    try {
      const response = await authFetch(
        `${baseUrl}/api/admin/bulk-jobs/${jobId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "Dispatched" }),
        },
      );

      if (!response.ok) throw new Error("Failed to dispatch truck");

      toast.info("Truck dispatched and routes calculated!");
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Failed to update bulk route");
    }
  };

  // Facility comparative chart data
  const chartData = facilities.map((f) => ({
    name: f.name
      .replace(" Central Hub", "")
      .replace(" Sorting Center", "")
      .replace(" Plant", "")
      .replace(" Hub", ""),
    "Pending Tonnage": f.pendingTonnage,
    "Bin Capacity %": f.averageFill,
  }));

  return (
    <PageLayout
      title="Enterprise Overview"
      description="Real-time multi-facility tracking, vehicle telemetry, and garbage collection logistics in Ghana."
    >
      {/* 1. Global Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <MetricCard
          title="Active Facilities"
          value={`${metrics.activeFacilitiesCount}/${metrics.facilitiesCount}`}
          trend="All systems nominal"
          trendDirection="neutral"
          iconColorClass="text-[#10b981] dark:text-emerald-500"
          iconBgClass="bg-[#10b981]/10 dark:bg-emerald-500/10"
          iconSvg={<Warehouse className="w-4 h-4" strokeWidth={2.5} />}
        />
        <MetricCard
          title="Online Sensors / Bins"
          value={metrics.deviceStatus}
          trend="+2.1% connectivity sync"
          trendDirection="up"
          iconColorClass="text-[#3b82f6] dark:text-blue-500"
          iconBgClass="bg-[#3b82f6]/10 dark:bg-blue-500/10"
          iconSvg={<Smartphone className="w-4 h-4" strokeWidth={2.5} />}
          linkTo="/devices"
        />
        <MetricCard
          title="Daily Items Sorted"
          value={metrics.totalItemsSorted}
          trend={`Recycling rate: ${metrics.recyclingRate}`}
          trendDirection="up"
          iconColorClass="text-[#10b981] dark:text-emerald-500"
          iconBgClass="bg-[#10b981]/10 dark:bg-emerald-500/10"
          iconSvg={<Activity className="w-4 h-4" strokeWidth={2.5} />}
          linkTo="/analytics"
        />
        <MetricCard
          title="Pending Tonnage"
          value={`${metrics.totalPendingTonnage} Tons`}
          trend={`${metrics.criticalAlertsCount} critical system alerts`}
          trendDirection={metrics.criticalAlertsCount > 0 ? "down" : "neutral"}
          iconColorClass="text-[#f59e0b] dark:text-amber-500"
          iconBgClass="bg-[#f59e0b]/10 dark:bg-amber-500/10"
          iconSvg={<Truck className="w-4 h-4" strokeWidth={2.5} />}
          linkTo="/alerts"
        />
      </div>

      {/* 2. Interactive Map and comparative analytics */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Leaflet Live Map */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl shadow-sm overflow-hidden flex flex-col min-h-[450px]">
          <div className="px-5 py-3.5 border-b border-border flex flex-wrap justify-between items-center gap-2 bg-slate-50/50 dark:bg-secondary/30">
            <div className="flex items-center gap-2.5">
              <span className="flex h-2.5 w-2.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
              <h3 className="font-bold text-sm text-foreground dark:text-white">
                Live Enterprise Fleet Tracking
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-muted-foreground hidden sm:inline-flex items-center gap-1.5 bg-background border border-border px-2.5 py-1 rounded-lg shadow-2xs">
                <Truck className="w-3.5 h-3.5 text-primary" />
                <span>
                  {activeDispatches.length} Vehicle{activeDispatches.length === 1 ? "" : "s"} En-Route • {facilities.length} Facilities
                </span>
              </span>
              <span className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-md font-mono font-bold">
                GPS LIVE
              </span>
            </div>
          </div>

          <div className="flex-1 relative" style={{ height: "400px" }}>
            {trackingTruckId && (
              <button
                onClick={() => {
                  setTrackingTruckId(null);
                }}
                data-testid="admin-stop-tracking-btn"
                className="absolute top-4 left-1/2 transform -translate-x-1/2 z-[1000] bg-white dark:bg-card px-4 py-2 rounded-full shadow-lg border border-border text-xs font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors flex items-center gap-2 cursor-pointer active:scale-[0.98]"
              >
                <span className="animate-pulse h-2 w-2 bg-red-500 rounded-full inline-block" />
                Stop Tracking
              </button>
            )}

            {/* Layer Filter Pills */}
            <div className="absolute top-3 right-14 z-10 bg-slate-900/85 backdrop-blur-md text-white p-1 rounded-xl shadow-lg border border-slate-700/60 flex items-center gap-1 text-xs">
              {(["all", "bins", "facilities"] as const).map((layer) => (
                <button
                  key={layer}
                  onClick={() => setLayerFilter(layer)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer active:scale-95 ${
                    layerFilter === layer
                      ? layer === "all"
                        ? "bg-emerald-500 text-white shadow-xs"
                        : layer === "bins"
                          ? "bg-sky-500 text-white shadow-xs"
                          : "bg-purple-500 text-white shadow-xs"
                      : "text-slate-300 hover:text-white hover:bg-slate-800/80"
                  }`}
                >
                  {layer === "all" ? "All" : layer === "bins" ? "Bins" : "Facilities"}
                </button>
              ))}
            </div>

            <MapLibreMap
              initialCenter={[-1.57, 6.675]}
              initialZoom={14}
              pins={filteredPins}
              vehicles={vehicleTelemetryList}
              activeTrackingId={trackingTruckId}
              height="100%"
            />
          </div>
        </div>

        {/* Third-Party Collection Dispatch Panel */}
        <div id="dispatch-controller-card" className="bg-card border border-border rounded-xl shadow-sm p-6 flex flex-col gap-4">
          <div>
            <h3 className="font-bold text-sm text-foreground dark:text-white">
              Third-Party Dispatch Controller
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Select an overloaded facility and assign a partner garbage
              collection agency in Ghana.
            </p>
          </div>

          {/* Quick-Fill Overloaded Facility Banner */}
          {(() => {
            const overloaded = facilities.filter((f) => (f.pendingTonnage || 0) >= 2.5);
            if (overloaded.length === 0) return null;
            return (
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-2 shadow-2xs">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Zap className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                  <span className="text-xs font-medium text-amber-900 dark:text-amber-300 truncate">
                    <strong>{overloaded[0].name}</strong> ({overloaded[0].pendingTonnage}T) over threshold
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleQuickDispatchFacility(overloaded[0])}
                  className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500 text-white shrink-0 hover:bg-amber-600 active:scale-95 transition-all cursor-pointer shadow-2xs"
                >
                  Quick Fill
                </button>
              </div>
            );
          })()}

          <form onSubmit={handleDispatchSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                Target Waste Facility
              </label>
              <select
                value={selectedFacilityId}
                data-testid="admin-dispatch-facility"
                onChange={(e) => setSelectedFacilityId(e.target.value)}
                className="h-10 px-3 border border-border rounded-lg text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all cursor-pointer"
              >
                <option value="">Select Facility...</option>
                {facilities.map((fac) => (
                  <option key={fac.id} value={fac.id}>
                    {fac.name} ({fac.pendingTonnage} Tons pending)
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Tonnage Volume (Tons)
                </label>
                <input
                  type="number"
                  step="0.1"
                  data-testid="admin-dispatch-tonnage"
                  value={tonnageInput}
                  onChange={(e) => setTonnageInput(e.target.value)}
                  className="h-10 px-3 border border-border rounded-lg text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Partner Contractor
                </label>
                <select
                  value={selectedCollectorName}
                  data-testid="admin-dispatch-collector"
                  onChange={(e) => setSelectedCollectorName(e.target.value)}
                  className="h-10 px-3 border border-border rounded-lg text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all cursor-pointer"
                >
                  <option value="Zoomlion Ghana Limited">Zoomlion</option>
                  <option value="Coliba Ghana">Coliba Ghana</option>
                  <option value="Jekora Ventures">Jekora Ventures</option>
                  <option value="Safisana Ghana">Safisana</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              data-testid="admin-dispatch-submit"
              disabled={isSubmitting || !selectedFacilityId}
              className="h-10 bg-primary hover:bg-primary/90 text-white font-bold text-sm rounded-lg transition-all shadow-md mt-1 cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
            >
              {isSubmitting
                ? "Processing Dispatch..."
                : "Assign Dispatch Route"}
            </button>
          </form>

          {/* Comparative Analytics visual chart */}
          <div className="border-t border-border pt-4 flex-1 flex flex-col justify-end">
            <h4 className="font-bold text-xs text-foreground dark:text-white uppercase tracking-wider mb-2">
              Facility comparative capacity
            </h4>
            <div style={{ width: "100%", height: "140px" }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 5, right: 5, left: -25, bottom: 5 }}
                >
                  <XAxis dataKey="name" stroke="#94a3b8" fontSize={9} />
                  <YAxis stroke="#94a3b8" fontSize={9} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "rgba(15, 23, 42, 0.95)",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: "8px",
                      color: "#fff",
                      fontSize: "11px",
                      backdropFilter: "blur(4px)",
                    }}
                  />
                  <Bar
                    dataKey="Pending Tonnage"
                    fill="#f59e0b"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Facility Detail Grid and active dispatch routes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Onboarded Facilities Detail Table */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl shadow-sm p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="font-bold text-sm text-foreground dark:text-white">
                Onboarded Facilities Health Metrics
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Direct tracking status of connected devices, fill ratios, and
                active error warnings.
              </p>
            </div>

            {/* Search & Filter Bar */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Filter facility..."
                  value={facilitySearch}
                  onChange={(e) => setFacilitySearch(e.target.value)}
                  className="pl-8 pr-7 py-1 text-xs bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 w-[140px] sm:w-[170px] transition-all"
                />
                {facilitySearch && (
                  <button
                    onClick={() => setFacilitySearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1 bg-background border border-border p-0.5 rounded-lg shadow-2xs">
                {(["all", "high_fill", "alerts"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFacilityFilter(f)}
                    className={`px-2 py-0.5 rounded-md text-[10px] font-bold transition-all cursor-pointer active:scale-95 ${
                      facilityFilter === f
                        ? f === "alerts"
                          ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30"
                          : f === "high_fill"
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30"
                            : "bg-primary text-white"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {f === "all" ? "All" : f === "high_fill" ? "≥75%" : "Alerts"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Facility Name</TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Region</TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Device Online</TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Avg Fill Level</TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Active Alerts</TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredFacilities.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-xs text-muted-foreground">
                      No facilities match your search or filter criteria.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredFacilities.map((fac) => (
                    <TableRow key={fac.id}>
                      <TableCell className="font-bold text-sm text-foreground dark:text-white">
                        {fac.name}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{fac.region}</TableCell>
                      <TableCell>
                        <span className="font-semibold text-xs text-foreground">
                          {fac.activeDevices} / {fac.deviceCount}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <Progress
                            value={fac.averageFill}
                            className={`h-2 flex-1 ${
                              fac.averageFill >= 80
                                ? "[&>[data-slot=progress-indicator]]:bg-rose-500"
                                : fac.averageFill >= 50
                                  ? "[&>[data-slot=progress-indicator]]:bg-amber-500"
                                  : "[&>[data-slot=progress-indicator]]:bg-emerald-500"
                            }`}
                          />
                          <span
                            className={`text-xs font-mono font-bold ${
                              fac.averageFill >= 80
                                ? "text-rose-600 dark:text-rose-400"
                                : fac.averageFill >= 50
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-emerald-600 dark:text-emerald-400"
                            }`}
                          >
                            {fac.averageFill}%
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                            fac.status === "Active"
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400"
                              : "bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-400"
                          }`}
                        >
                          {fac.status}
                        </span>
                      </TableCell>
                      <TableCell>
                        {fac.alertCount > 0 ? (
                          <span className="inline-flex items-center gap-1 bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-400 px-2 py-0.5 rounded text-[10px] font-bold animate-pulse">
                            ⚠️ {fac.alertCount} Alerts
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            None
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {fac.pendingTonnage >= 2.0 && (
                            <button
                              onClick={() => handleQuickDispatchFacility(fac)}
                              className="text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 border border-amber-500/30 px-2 py-1 rounded-md font-semibold transition-all cursor-pointer active:scale-95 shadow-2xs"
                              title="Pre-fill Dispatch Form"
                            >
                              Dispatch
                            </button>
                          )}
                          <Link
                            to={`/dashboard?facilityId=${fac.id}`}
                            data-testid={`admin-inspect-${fac.id}`}
                            className="text-xs bg-primary hover:bg-primary/90 text-white px-2.5 py-1 rounded-md font-medium transition-all cursor-pointer active:scale-95 inline-block shadow-2xs"
                          >
                            Inspect
                          </Link>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Third-Party Active Routes Table */}
        <div className="bg-card border border-border rounded-xl shadow-sm p-6 flex flex-col">
          <div className="mb-4">
            <h3 className="font-bold text-sm text-foreground dark:text-white">
              Active Dispatch Routes
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Current partner collection routes underway based on tonnage
              alerts.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto max-h-[300px] flex flex-col gap-3">
            {bulkJobs.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-xs font-medium">
                No active routes scheduled
              </div>
            ) : (
              bulkJobs.map((job) => {
                const statusColor =
                  job.status === "Completed"
                    ? "bg-emerald-500/10 text-emerald-500"
                    : job.status === "Dispatched"
                      ? "bg-blue-500/10 text-blue-500"
                      : "bg-amber-500/10 text-amber-500";

                return (
                  <div
                    key={job.id}
                    className="p-4 border border-border rounded-xl flex flex-col gap-2 hover:bg-slate-50 dark:hover:bg-secondary/20 transition-all"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold text-muted-foreground">
                        {job.id.substring(0, 8).toUpperCase()}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-wider ${statusColor}`}
                      >
                        {job.status}
                      </span>
                    </div>

                    <div className="flex flex-col">
                      <strong className="text-xs text-foreground dark:text-white">
                        {job.facility?.name}
                      </strong>
                      <span className="text-[10px] text-muted-foreground mt-0.5">
                        Contractor: {job.collectorName}
                      </span>
                    </div>

                    <div className="flex items-center justify-between border-t border-border/60 pt-2 mt-1">
                      <span className="text-xs font-bold text-foreground">
                        Tonnage: {job.tonnage} Tons
                      </span>

                      {job.status === "Pending" && (
                        <button
                          onClick={() => handleTransitPickup(job.id)}
                          data-testid={`admin-dispatch-truck-${job.id}`}
                          className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold rounded cursor-pointer transition-colors active:scale-[0.98]"
                        >
                          Dispatch Truck
                        </button>
                      )}

                      {job.status === "Dispatched" && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() =>
                              setTrackingTruckId(
                                trackingTruckId === job.id ? null : job.id,
                              )
                            }
                            data-testid={`admin-track-truck-${job.id}`}
                            className={`px-2.5 py-1 ${trackingTruckId === job.id ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"} text-[10px] font-bold rounded cursor-pointer transition-colors flex items-center gap-1 active:scale-[0.98]`}
                          >
                            {trackingTruckId === job.id
                              ? "🎯 Tracking..."
                              : "🎯 Track"}
                          </button>
                          <button
                            onClick={() => handleCompletePickup(job.id)}
                            data-testid={`admin-complete-truck-${job.id}`}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold rounded cursor-pointer transition-colors active:scale-[0.98]"
                          >
                            Mark Collected
                          </button>
                        </div>
                      )}

                      {job.status === "Completed" && (
                        <span className="text-[9.5px] text-muted-foreground italic">
                          Collected:{" "}
                          {job.completedAt
                            ? new Date(job.completedAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "Done"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
