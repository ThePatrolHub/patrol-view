import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  runTransaction,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import {
  Bell,
  CheckCircle2,
  Compass,
  LogOut,
  MapPinned,
  MessageSquare,
  ShieldCheck,
  Siren,
  TriangleAlert,
  UserRound,
  Users,
} from 'lucide-react';
import { auth, db } from './firebase';
import type {
  AlertRecord,
  AppTab,
  BoardPost,
  MentionRecord,
  PatrolPoint,
  PatrolRecord,
  PlannedRoute,
  ToastMessage,
  UserProfile,
} from './types';
import {
  DEFAULT_CENTER,
  cleanDisplayName,
  extractMentionedUsers,
  formatDuration,
  formatTimeAgo,
  getPatrollerTrackingStatus,
  getUserDisplayName,
  googleMapsDirectionsUrl,
  haversineMeters,
  highlightMentions,
  normalizeDisplayName,
  pickAvatarColor,
} from './utils';
import { AuthScreen } from './components/AuthScreen';
import { GlassCard } from './components/GlassCard';
import { MapPanel } from './components/MapPanel';
import { ToastStack } from './components/ToastStack';

interface PatrolTrackerResult {
  viewerRoute: PatrolPoint[];
  elapsedSeconds: number;
  tracking: boolean;
  patrolBusy: boolean;
  gpsWarning: string | null;
  gpsPermission: string;
  startPatrol: () => Promise<void>;
  endPatrol: () => Promise<void>;
  requestAssistance: () => Promise<void>;
}

function fromDoc<T>(snapshot: { id: string; data: () => unknown }) {
  return { id: snapshot.id, ...(snapshot.data() as Record<string, unknown>) } as T & { id: string };
}

interface ActiveMentionDraft {
  start: number;
  end: number;
  query: string;
}

function getActiveMentionDraft(value: string, caretPosition: number) {
  const beforeCaret = value.slice(0, caretPosition);
  const match = beforeCaret.match(/(^|[\s(\[{])@([^\n@]{0,50})$/);
  if (!match) return null;

  const start = beforeCaret.length - match[2].length - 1;
  return {
    start,
    end: caretPosition,
    query: match[2].trimStart(),
  } satisfies ActiveMentionDraft;
}

async function fetchWalkRouteSegment(start: { lat: number; lng: number }, end: { lat: number; lng: number }) {
  const url = new URL(
    `https://router.project-osrm.org/route/v1/foot/${start.lng},${start.lat};${end.lng},${end.lat}`
  );
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('steps', 'false');

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error('Route snapping service is temporarily unavailable.');
  }

  const payload = (await response.json()) as {
    routes?: Array<{ geometry?: { coordinates?: [number, number][] } }>;
  };

  const coordinates = payload.routes?.[0]?.geometry?.coordinates;
  if (!coordinates?.length) {
    return null;
  }

  return coordinates.map(([lng, lat]) => ({ lat, lng }));
}

function flattenDraftRouteSegments(segments: Array<Array<{ lat: number; lng: number }>>) {
  return segments.flatMap((segment, index) => (index === 0 ? segment : segment.slice(1)));
}

function formatPatrolDateTime(value?: Timestamp | null) {
  if (!value) return 'Unknown time';
  return value.toDate().toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}


function usePatrolTracker(profile: UserProfile | null, pushToast: (title: string, body: string) => void): PatrolTrackerResult {
  const [viewerRoute, setViewerRoute] = useState<PatrolPoint[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [patrolBusy, setPatrolBusy] = useState(false);
  const [gpsWarning, setGpsWarning] = useState<string | null>(null);
  const [gpsPermission, setGpsPermission] = useState('unknown');
  const watchIdRef = useRef<number | null>(null);
  const lastSavedRef = useRef<{ at: number; lat: number; lng: number } | null>(null);
  const timerRef = useRef<number | null>(null);
  const patrolIdRef = useRef<string | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const updateElapsedFromProfile = useCallback((nextProfile: UserProfile | null) => {
    if (!nextProfile?.currentPatrolStartedAt) {
      setElapsedSeconds(0);
      return;
    }

    const startedAt = nextProfile.currentPatrolStartedAt.toDate().getTime();
    setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    stopTimer();
    timerRef.current = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
  }, [stopTimer]);

  useEffect(() => {
    let status: PermissionStatus | null = null;

    async function checkPermission() {
      try {
        if (!('permissions' in navigator)) return;
        status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
        setGpsPermission(status.state);
        status.onchange = () => setGpsPermission(status?.state ?? 'unknown');
      } catch {
        setGpsPermission('unknown');
      }
    }

    checkPermission();

    return () => {
      if (status) {
        status.onchange = null;
      }
    };
  }, []);

  useEffect(() => {
    if (profile?.isPatrolling && profile.currentPatrolId) {
      patrolIdRef.current = profile.currentPatrolId;
      updateElapsedFromProfile(profile);
    } else {
      patrolIdRef.current = null;
      stopTimer();
      setElapsedSeconds(0);
    }

    return () => {
      if (!profile?.isPatrolling) {
        stopTimer();
      }
    };
  }, [profile, stopTimer, updateElapsedFromProfile]);

  useEffect(() => {
    if (!profile?.currentPatrolId) {
      setViewerRoute([]);
      return;
    }

    const pointsQuery = query(
      collection(db, `patrols/${profile.currentPatrolId}/points`),
      orderBy('recordedAt', 'asc'),
      limit(300)
    );

    return onSnapshot(pointsQuery, (snapshot) => {
      setViewerRoute(snapshot.docs.map((docSnap) => fromDoc<PatrolPoint>(docSnap)));
    });
  }, [profile?.currentPatrolId]);

  const beginWatch = useCallback((patrolId: string) => {
    if (!profile) return;
    if (!navigator.geolocation) {
      setGpsWarning('This browser does not support location tracking.');
      return;
    }

    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      async (position) => {
        const point = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy ?? null,
          heading: position.coords.heading ?? null,
          speed: position.coords.speed ?? null,
        };

        setGpsWarning(null);

        const now = Date.now();
        const previous = lastSavedRef.current;
        const shouldPersist =
          !previous ||
          now - previous.at > 20000 ||
          haversineMeters({ lat: previous.lat, lng: previous.lng }, point) > 20;

        try {
          await updateDoc(doc(db, 'users', profile.uid), {
            lastLocation: { ...point, updatedAt: serverTimestamp() },
            lastSeenAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          if (shouldPersist) {
            await addDoc(collection(db, `patrols/${patrolId}/points`), {
              userId: profile.uid,
              patrolId,
              ...point,
              recordedAt: serverTimestamp(),
            });
            lastSavedRef.current = { at: now, lat: point.lat, lng: point.lng };
          }
        } catch (error) {
          console.error('Live tracking update failed', error);
        }
      },
      (error) => {
        if (error.code === 1) {
          setGpsWarning('Location permission was denied. Enable GPS/location and try again.');
        } else {
          setGpsWarning('Live GPS update is delayed. Keep the page open, wait a few seconds, and make sure precise location is allowed in your browser settings.');
        }
      },
      { enableHighAccuracy: false, maximumAge: 20000, timeout: 30000 }
    );
  }, [profile]);

  useEffect(() => {
    if (profile?.isPatrolling && profile.currentPatrolId && watchIdRef.current === null) {
      beginWatch(profile.currentPatrolId);
    }

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [beginWatch, profile?.currentPatrolId, profile?.isPatrolling]);

  const startPatrol = useCallback(async () => {
    if (!profile) return;
    if (!window.isSecureContext) {
      setGpsWarning('Location only works on a secure HTTPS page. Open the GitHub Pages link, not a local file or insecure preview.');
      return;
    }
    if (!navigator.geolocation) {
      setGpsWarning('This browser does not support GPS tracking.');
      return;
    }

    setPatrolBusy(true);
    setGpsWarning(null);

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 30000,
        });
      });

      const patrolRef = doc(collection(db, 'patrols'));
      const firstPoint = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy ?? null,
        heading: position.coords.heading ?? null,
        speed: position.coords.speed ?? null,
      };

      await setDoc(patrolRef, {
        userId: profile.uid,
        username: profile.username,
        startedAt: serverTimestamp(),
        endedAt: null,
        active: true,
        durationSeconds: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await updateDoc(doc(db, 'users', profile.uid), {
        isPatrolling: true,
        currentPatrolId: patrolRef.id,
        currentPatrolStartedAt: serverTimestamp(),
        lastLocation: { ...firstPoint, updatedAt: serverTimestamp() },
        lastSeenAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await addDoc(collection(db, `patrols/${patrolRef.id}/points`), {
        userId: profile.uid,
        patrolId: patrolRef.id,
        ...firstPoint,
        recordedAt: serverTimestamp(),
      });

      patrolIdRef.current = patrolRef.id;
      lastSavedRef.current = { at: Date.now(), lat: firstPoint.lat, lng: firstPoint.lng };
      beginWatch(patrolRef.id);
      pushToast('Patrol started', 'Your live location and route are now shared with active patrollers.');
    } catch (error) {
      const geoError = error as GeolocationPositionError;
      if (typeof geoError?.code === 'number') {
        setGpsWarning(
          geoError.code === 1
            ? 'GPS/location permission is blocked. Enable it on your device and browser to start a patrol.'
            : 'No reliable GPS fix yet. Wait a little longer, move somewhere with a clearer sky view, and make sure precise location is allowed for this site.'
        );
      } else {
        const message = error instanceof Error ? error.message : 'Could not start patrol.';
        setGpsWarning(message);
      }
    } finally {
      setPatrolBusy(false);
    }
  }, [beginWatch, profile, pushToast]);

  const endPatrol = useCallback(async () => {
    if (!profile?.currentPatrolId) return;
    setPatrolBusy(true);

    try {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }

      await updateDoc(doc(db, 'patrols', profile.currentPatrolId), {
        active: false,
        endedAt: serverTimestamp(),
        durationSeconds: elapsedSeconds,
        updatedAt: serverTimestamp(),
      });

      await updateDoc(doc(db, 'users', profile.uid), {
        isPatrolling: false,
        currentPatrolId: null,
        currentPatrolStartedAt: null,
        lastSeenAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      pushToast('Patrol ended', `Tracked time saved: ${formatDuration(elapsedSeconds)}.`);
    } catch (error) {
      console.error(error);
      setGpsWarning(error instanceof Error ? error.message : 'Could not end patrol cleanly.');
    } finally {
      setPatrolBusy(false);
    }
  }, [elapsedSeconds, profile, pushToast]);

  const requestAssistance = useCallback(async () => {
    if (!profile) return;
    if (!window.isSecureContext) {
      setGpsWarning('Location only works on a secure HTTPS page. Open the GitHub Pages link, not a local file or insecure preview.');
      return;
    }
    setPatrolBusy(true);

    try {
      if (!profile.lastLocation && !navigator.geolocation) {
        throw new Error('This browser cannot access GPS. Open the app on a device with location services enabled.');
      }

      const currentLocation = profile.lastLocation
        ? profile.lastLocation
        : await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              maximumAge: 0,
              timeout: 20000,
            });
          }).then((position) => ({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy ?? null,
            heading: position.coords.heading ?? null,
            speed: position.coords.speed ?? null,
          }));

      await addDoc(collection(db, 'alerts'), {
        createdBy: profile.uid,
        username: profile.username,
        message: 'Assistance requested. Please respond if you are nearby.',
        location: { ...currentLocation, updatedAt: serverTimestamp() },
        active: true,
        createdAt: serverTimestamp(),
        resolvedAt: null,
      });

      pushToast('Assistance requested', 'All connected patrollers can now see your alert and open directions.');
    } catch (error) {
      setGpsWarning(error instanceof Error ? error.message : 'Could not create assistance alert.');
    } finally {
      setPatrolBusy(false);
    }
  }, [profile, pushToast]);

  return {
    viewerRoute,
    elapsedSeconds,
    tracking: Boolean(profile?.isPatrolling),
    patrolBusy,
    gpsWarning,
    gpsPermission,
    startPatrol,
    endPatrol,
    requestAssistance,
  };
}

function App() {
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tab, setTab] = useState<AppTab>('patrol');
  const [activePatrollers, setActivePatrollers] = useState<UserProfile[]>([]);
  const [pendingUsers, setPendingUsers] = useState<UserProfile[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [plannedRoutes, setPlannedRoutes] = useState<PlannedRoute[]>([]);
  const [posts, setPosts] = useState<BoardPost[]>([]);
  const [mentions, setMentions] = useState<MentionRecord[]>([]);
  const [mentionableUsers, setMentionableUsers] = useState<UserProfile[]>([]);
  const [selectedPatroller, setSelectedPatroller] = useState<UserProfile | null>(null);
  const [selectedPatrollerRoute, setSelectedPatrollerRoute] = useState<PatrolPoint[]>([]);
  const [patrolHistory, setPatrolHistory] = useState<PatrolRecord[]>([]);
  const [historyRoutePatrolId, setHistoryRoutePatrolId] = useState<string | null>(null);
  const [historyRoutePoints, setHistoryRoutePoints] = useState<PatrolPoint[]>([]);
  const [draftRouteName, setDraftRouteName] = useState('Evening Patrol Route');
  const [draftRouteAnchors, setDraftRouteAnchors] = useState<Array<{ lat: number; lng: number }>>([]);
  const [draftRouteSegments, setDraftRouteSegments] = useState<Array<Array<{ lat: number; lng: number }>>>([]);
  const [drawMode, setDrawMode] = useState(false);
  const [postInput, setPostInput] = useState('');
  const [activeMentionDraft, setActiveMentionDraft] = useState<ActiveMentionDraft | null>(null);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [boardBusy, setBoardBusy] = useState(false);
  const [routeBusy, setRouteBusy] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  );
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const isiOS = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }, []);
  const isStandalonePwa = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
    return window.matchMedia?.('(display-mode: standalone)').matches
      || Boolean(standaloneNavigator.standalone);
  }, []);
  const [pageVisibility, setPageVisibility] = useState(() =>
    typeof document === 'undefined' ? 'visible' : document.visibilityState
  );
  const [, setClockTick] = useState(0);
  const resumedPatrolToastShown = useRef(false);
  const backgroundReturnToastShown = useRef(false);
  const postComposerRef = useRef<HTMLTextAreaElement | null>(null);

  const draftRoutePoints = useMemo(() => flattenDraftRouteSegments(draftRouteSegments), [draftRouteSegments]);

  const pushToast = useCallback((title: string, body: string) => {
    const next = { id: `${Date.now()}-${Math.random()}`, title, body };
    setToasts((current) => [...current, next]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== next.id));
    }, 4200);
  }, []);

  const syncNotificationPermission = useCallback(() => {
    setNotificationPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  }, []);

  const patrolTracker = usePatrolTracker(profile, pushToast);

  useEffect(() => {
    const interval = window.setInterval(() => setClockTick((value) => value + 1), 30000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => setPageVisibility(document.visibilityState);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    syncNotificationPermission();
    window.addEventListener('focus', syncNotificationPermission);
    document.addEventListener('visibilitychange', syncNotificationPermission);
    return () => {
      window.removeEventListener('focus', syncNotificationPermission);
      document.removeEventListener('visibilitychange', syncNotificationPermission);
    };
  }, [syncNotificationPermission]);

  useEffect(() => {
    if (!profile?.isPatrolling || !profile.currentPatrolId) {
      resumedPatrolToastShown.current = false;
      return;
    }

    if (resumedPatrolToastShown.current) return;
    resumedPatrolToastShown.current = true;
    pushToast('Patrol resumed', 'Your patrol is still active. Live tracking continues while this page stays open and connected.');
  }, [profile?.currentPatrolId, profile?.isPatrolling, pushToast]);

  useEffect(() => {
    if (!profile?.isPatrolling) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [profile?.isPatrolling]);

  useEffect(() => {
    if (!profile?.isPatrolling) {
      backgroundReturnToastShown.current = false;
      return;
    }

    if (pageVisibility === 'hidden') {
      backgroundReturnToastShown.current = true;
      return;
    }

    if (!backgroundReturnToastShown.current) return;
    backgroundReturnToastShown.current = false;
    pushToast('Tracking resumed', 'You are back in the app. If location updates paused in the background, they can continue now.');
  }, [pageVisibility, profile?.isPatrolling, pushToast]);

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!authUser) {
      setProfile(null);
      return;
    }

    return onSnapshot(doc(db, 'users', authUser.uid), (snapshot) => {
      if (!snapshot.exists()) {
        setProfile(null);
        return;
      }
      setProfile(snapshot.data() as UserProfile);
    });
  }, [authUser]);

  useEffect(() => {
    if (!profile?.approved) {
      setActivePatrollers([]);
      setAlerts([]);
      setPlannedRoutes([]);
      setPosts([]);
      setMentions([]);
      setMentionableUsers([]);
      setPendingUsers([]);
      return;
    }

    const unsubscribers: Unsubscribe[] = [];

    unsubscribers.push(
      onSnapshot(query(collection(db, 'users'), where('approved', '==', true)), (snapshot) => {
        const approvedUsers = snapshot.docs.map((docSnap) => docSnap.data() as UserProfile);
        const sortedUsers = [...approvedUsers].sort((left, right) => left.usernameLower.localeCompare(right.usernameLower));
        setMentionableUsers(sortedUsers);
      })
    );

    unsubscribers.push(
      onSnapshot(
        query(collection(db, 'users'), where('approved', '==', true), where('isPatrolling', '==', true), orderBy('usernameLower')),
        (snapshot) => {
          setActivePatrollers(snapshot.docs.map((docSnap) => docSnap.data() as UserProfile));
        }
      )
    );

    unsubscribers.push(
      onSnapshot(
        query(collection(db, 'alerts'), where('active', '==', true), orderBy('createdAt', 'desc'), limit(12)),
        (snapshot) => {
          setAlerts(snapshot.docs.map((docSnap) => fromDoc<AlertRecord>(docSnap)));
        }
      )
    );

    unsubscribers.push(
      onSnapshot(
        query(collection(db, 'plannedRoutes'), where('archived', '==', false), orderBy('createdAt', 'desc'), limit(25)),
        (snapshot) => {
          setPlannedRoutes(snapshot.docs.map((docSnap) => fromDoc<PlannedRoute>(docSnap)));
        }
      )
    );

    unsubscribers.push(
      onSnapshot(query(collection(db, 'posts'), orderBy('createdAt', 'desc'), limit(50)), (snapshot) => {
        setPosts(snapshot.docs.map((docSnap) => fromDoc<BoardPost>(docSnap)));
      })
    );

    unsubscribers.push(
      onSnapshot(query(collection(db, `mentions/${profile.uid}/items`), orderBy('createdAt', 'desc'), limit(30)), (snapshot) => {
        setMentions(snapshot.docs.map((docSnap) => fromDoc<MentionRecord>(docSnap)));
      })
    );

    unsubscribers.push(
      onSnapshot(query(collection(db, 'patrols'), where('userId', '==', profile.uid), limit(100)), (snapshot) => {
        const nextPatrols = snapshot.docs
          .map((docSnap) => fromDoc<PatrolRecord>(docSnap))
          .sort((a, b) => (b.startedAt?.toMillis() ?? 0) - (a.startedAt?.toMillis() ?? 0));
        setPatrolHistory(nextPatrols);
      })
    );

    if (profile.role === 'admin') {
      unsubscribers.push(
        onSnapshot(
          query(collection(db, 'users'), where('approved', '==', false), orderBy('createdAt', 'desc'), limit(50)),
          (snapshot) => {
            setPendingUsers(snapshot.docs.map((docSnap) => docSnap.data() as UserProfile));
          }
        )
      );
    }

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [profile?.approved, profile?.role, profile?.uid]);

  useEffect(() => {
    if (!selectedPatroller?.currentPatrolId) {
      setSelectedPatrollerRoute([]);
      return;
    }

    return onSnapshot(
      query(collection(db, `patrols/${selectedPatroller.currentPatrolId}/points`), orderBy('recordedAt', 'asc'), limit(300)),
      (snapshot) => {
        setSelectedPatrollerRoute(snapshot.docs.map((docSnap) => fromDoc<PatrolPoint>(docSnap)));
      }
    );
  }, [selectedPatroller?.currentPatrolId]);

  useEffect(() => {
    if (!historyRoutePatrolId) {
      setHistoryRoutePoints([]);
      return;
    }

    return onSnapshot(
      query(collection(db, `patrols/${historyRoutePatrolId}/points`), orderBy('recordedAt', 'asc'), limit(500)),
      (snapshot) => {
        setHistoryRoutePoints(snapshot.docs.map((docSnap) => fromDoc<PatrolPoint>(docSnap)));
      }
    );
  }, [historyRoutePatrolId]);

  const seenAlertIds = useRef<Set<string>>(new Set());
  const seenMentionIds = useRef<Set<string>>(new Set());
  const alertsInitialized = useRef(false);
  const mentionsInitialized = useRef(false);

  useEffect(() => {
    if (!profile?.approved) return;

    if (!alertsInitialized.current) {
      alerts.forEach((alert) => seenAlertIds.current.add(alert.id));
      alertsInitialized.current = true;
      return;
    }

    alerts.forEach((alert) => {
      if (seenAlertIds.current.has(alert.id) || alert.createdBy === profile.uid) return;
      seenAlertIds.current.add(alert.id);
      pushToast('Assistance alert', `${alert.username} requested assistance.`);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('Patrol Hub', { body: `${alert.username} requested assistance.` });
      }
    });
  }, [alerts, profile?.approved, profile?.uid, pushToast]);

  useEffect(() => {
    if (!profile?.approved) return;

    if (!mentionsInitialized.current) {
      mentions.forEach((mention) => seenMentionIds.current.add(mention.id));
      mentionsInitialized.current = true;
      return;
    }

    mentions.forEach((mention) => {
      if (seenMentionIds.current.has(mention.id)) return;
      seenMentionIds.current.add(mention.id);
      if (!mention.read) {
        pushToast('You were tagged', `${mention.fromUsername} mentioned you on the board.`);
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('Patrol Hub', { body: `${mention.fromUsername} mentioned you.` });
        }
      }
    });
  }, [mentions, profile?.approved, pushToast]);

  useEffect(() => {
    seenAlertIds.current.clear();
    seenMentionIds.current.clear();
    alertsInitialized.current = false;
    mentionsInitialized.current = false;
  }, [profile?.uid]);

  const unreadMentions = useMemo(() => mentions.filter((item) => !item.read).length, [mentions]);

  const mentionSuggestions = useMemo(() => {
    if (!activeMentionDraft) return [];
    const normalizedQuery = normalizeDisplayName(activeMentionDraft.query);

    return mentionableUsers
      .filter((user) => user.uid !== profile?.uid)
      .filter((user) => {
        if (!normalizedQuery) return true;
        return normalizeDisplayName(getUserDisplayName(user)).includes(normalizedQuery);
      })
      .slice(0, 6);
  }, [activeMentionDraft, mentionableUsers, profile?.uid]);

  useEffect(() => {
    setSelectedMentionIndex(0);
  }, [activeMentionDraft?.query]);

  const syncMentionDraft = useCallback((value: string, caretPosition: number | null | undefined) => {
    const safeCaret = caretPosition ?? value.length;
    setActiveMentionDraft(getActiveMentionDraft(value, safeCaret));
  }, []);

  const handlePostInputChange = useCallback((value: string, caretPosition: number | null | undefined) => {
    setPostInput(value);
    syncMentionDraft(value, caretPosition);
  }, [syncMentionDraft]);

  const insertMention = useCallback((user: UserProfile) => {
    if (!activeMentionDraft) return;

    const displayName = getUserDisplayName(user);
    const nextValue = `${postInput.slice(0, activeMentionDraft.start)}@${displayName} ${postInput.slice(activeMentionDraft.end)}`;
    const nextCaretPosition = activeMentionDraft.start + displayName.length + 2;

    setPostInput(nextValue);
    setActiveMentionDraft(null);
    setSelectedMentionIndex(0);

    window.requestAnimationFrame(() => {
      const textarea = postComposerRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextCaretPosition, nextCaretPosition);
    });
  }, [activeMentionDraft, postInput]);

  const handleComposerKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionSuggestions.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedMentionIndex((current) => (current + 1) % mentionSuggestions.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedMentionIndex((current) => (current - 1 + mentionSuggestions.length) % mentionSuggestions.length);
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      insertMention(mentionSuggestions[selectedMentionIndex] ?? mentionSuggestions[0]);
      return;
    }

    if (event.key === 'Escape') {
      setActiveMentionDraft(null);
    }
  }, [insertMention, mentionSuggestions, selectedMentionIndex]);

  const handleLogin = useCallback(async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  }, []);

  const handleRegister = useCallback(async ({ email, password, displayName }: { email: string; password: string; displayName: string }) => {
    const cleanedName = cleanDisplayName(displayName);
    const normalizedDisplayName = normalizeDisplayName(cleanedName);

    if (
      cleanedName.length < 3 ||
      cleanedName.length > 40 ||
      !/^[A-Za-z0-9][A-Za-z0-9 .'-]*[A-Za-z0-9.]$/.test(cleanedName)
    ) {
      throw new Error('Full name must be 3 to 40 characters using letters, numbers, spaces, apostrophes, dots, or hyphens.');
    }

    const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
    const userRef = doc(db, 'users', credential.user.uid);
    const usernameRef = doc(db, 'usernames', normalizedDisplayName);

    try {
      await runTransaction(db, async (transaction) => {
        const existing = await transaction.get(usernameRef);
        if (existing.exists()) {
          throw new Error('That name is already taken. Please use a slightly different display name.');
        }

        transaction.set(userRef, {
          uid: credential.user.uid,
          email: email.trim(),
          username: cleanedName,
          usernameLower: normalizedDisplayName,
          displayName: cleanedName,
          approved: false,
          role: 'user',
          avatarColor: pickAvatarColor(cleanedName),
          isPatrolling: false,
          currentPatrolId: null,
          currentPatrolStartedAt: null,
          lastLocation: null,
          lastSeenAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        transaction.set(usernameRef, {
          uid: credential.user.uid,
          username: cleanedName,
          usernameLower: normalizedDisplayName,
          createdAt: serverTimestamp(),
        });
      });
    } catch (error) {
      await deleteUser(credential.user).catch(() => undefined);
      throw error;
    }
  }, []);

  const handleLogout = useCallback(async () => {
    await signOut(auth);
  }, []);

  const requestNotificationPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      if (isiOS && !isStandalonePwa) {
        pushToast(
          'Install to Home Screen first',
          'On iPhone and iPad, web notifications only work after you add this site to your Home Screen and open it from there.'
        );
        return;
      }

      pushToast(
        'Notifications unavailable',
        'This mobile browser does not support web notifications for this site. Try Chrome or Firefox on Android, or a Home Screen install on iPhone/iPad.'
      );
      return;
    }

    if (isiOS && !isStandalonePwa) {
      pushToast(
        'Install to Home Screen first',
        'On iPhone and iPad, Safari only allows web notification prompts for Home Screen web apps.'
      );
      return;
    }

    if (Notification.permission === 'denied') {
      setNotificationPermission('denied');
      pushToast('Notifications blocked', 'Open your browser site settings and allow notifications for this site.');
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);

    if (permission === 'granted') {
      try {
        new Notification('LNW Patrol Map', { body: 'Notifications are enabled on this device.' });
      } catch {
        // Some mobile browsers grant permission but do not show a test notification reliably.
      }
      pushToast('Notifications enabled', 'You will now see alert and mention notifications while the app is open.');
      return;
    }

    if (permission === 'denied') {
      pushToast('Notifications blocked', 'Open your browser site settings and allow notifications for this site.');
      return;
    }

    pushToast(
      'No notification permission yet',
      'Your browser did not show or complete a notification prompt. On some phones this only works in supported browsers or installed web apps.'
    );
  }, [isStandalonePwa, isiOS, pushToast]);

  const approveUser = useCallback(async (uid: string) => {
    await updateDoc(doc(db, 'users', uid), {
      approved: true,
      updatedAt: serverTimestamp(),
    });
    pushToast('User approved', 'The account can now access the patrol dashboard.');
  }, [pushToast]);

  const promoteUser = useCallback(async (uid: string) => {
    await updateDoc(doc(db, 'users', uid), {
      approved: true,
      role: 'admin',
      updatedAt: serverTimestamp(),
    });
    pushToast('Admin granted', 'That account can now approve other users.');
  }, [pushToast]);

  const resolveAlert = useCallback(async (alertId: string) => {
    await updateDoc(doc(db, 'alerts', alertId), {
      active: false,
      resolvedAt: serverTimestamp(),
    });
    pushToast('Alert closed', 'The assistance alert has been resolved.');
  }, [pushToast]);

  const addDraftRouteStop = useCallback(async (point: { lat: number; lng: number }) => {
    if (routeBusy) return;
    setRouteBusy(true);

    try {
      if (!draftRouteAnchors.length) {
        setDraftRouteAnchors([point]);
        setDraftRouteSegments([[point]]);
        pushToast('Route start added', 'Tap the next street corner or destination and the app will try to follow the road network.');
        return;
      }

      const previousAnchor = draftRouteAnchors[draftRouteAnchors.length - 1];
      let nextSegment = [previousAnchor, point];

      try {
        const snappedSegment = await fetchWalkRouteSegment(previousAnchor, point);
        if (snappedSegment && snappedSegment.length > 1) {
          nextSegment = snappedSegment;
        }
      } catch {
        pushToast('Snapping unavailable', 'The free road-snapping service did not respond, so this segment was added as a straight line.');
      }

      setDraftRouteAnchors((current) => [...current, point]);
      setDraftRouteSegments((current) => [...current, nextSegment]);
    } finally {
      setRouteBusy(false);
    }
  }, [draftRouteAnchors, pushToast, routeBusy]);

  const savePlannedRoute = useCallback(async () => {
    if (!profile || draftRoutePoints.length < 2) {
      pushToast('Route not saved', 'Add at least two map points before saving a route.');
      return;
    }

    setRouteBusy(true);
    try {
      await addDoc(collection(db, 'plannedRoutes'), {
        createdBy: profile.uid,
        username: profile.username,
        name: draftRouteName.trim() || 'Planned patrol route',
        points: draftRoutePoints,
        archived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setDraftRouteAnchors([]);
      setDraftRouteSegments([]);
      setDrawMode(false);
      pushToast('Route saved', 'Everyone can now see the planned route on the shared map.');
    } finally {
      setRouteBusy(false);
    }
  }, [draftRouteName, draftRouteAnchors, draftRoutePoints, profile, pushToast]);

  const submitPost = useCallback(async () => {
    if (!profile || !postInput.trim()) return;
    setBoardBusy(true);

    try {
      const mentionedUsers = extractMentionedUsers(postInput.trim(), mentionableUsers);
      const postRef = doc(collection(db, 'posts'));
      const batch = writeBatch(db);

      batch.set(postRef, {
        authorId: profile.uid,
        username: getUserDisplayName(profile),
        content: postInput.trim(),
        mentions: mentionedUsers.map((user) => user.uid),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      for (const mentionedUser of mentionedUsers) {
        if (mentionedUser.uid === profile.uid) continue;

        batch.set(doc(collection(db, `mentions/${mentionedUser.uid}/items`)), {
          toUid: mentionedUser.uid,
          fromUid: profile.uid,
          fromUsername: getUserDisplayName(profile),
          postId: postRef.id,
          createdAt: serverTimestamp(),
          read: false,
          readAt: null,
        });
      }

      await batch.commit();
      setPostInput('');
      setActiveMentionDraft(null);
      setSelectedMentionIndex(0);
      pushToast('Post published', 'Your board post is now visible to everyone in the patrol team.');
    } finally {
      setBoardBusy(false);
    }
  }, [mentionableUsers, postInput, profile, pushToast]);

  const markMentionRead = useCallback(async (mention: MentionRecord) => {
    if (!profile || mention.read) return;
    await updateDoc(doc(db, `mentions/${profile.uid}/items`, mention.id), {
      read: true,
      readAt: serverTimestamp(),
    });
  }, [profile]);

  const focusedUser = selectedPatroller ?? profile;

  const patrolSummary = useMemo(() => {
    const now = new Date();
    let day = 0;
    let month = 0;
    let year = 0;

    patrolHistory.forEach((patrol) => {
      const startedAt = patrol.startedAt?.toDate();
      if (!startedAt) return;

      const duration =
        patrol.active && profile?.currentPatrolId === patrol.id
          ? patrolTracker.elapsedSeconds
          : patrol.durationSeconds ?? 0;

      if (
        startedAt.getFullYear() === now.getFullYear()
        && startedAt.getMonth() === now.getMonth()
        && startedAt.getDate() === now.getDate()
      ) {
        day += duration;
      }

      if (
        startedAt.getFullYear() === now.getFullYear()
        && startedAt.getMonth() === now.getMonth()
      ) {
        month += duration;
      }

      if (startedAt.getFullYear() === now.getFullYear()) {
        year += duration;
      }
    });

    return { day, month, year };
  }, [patrolHistory, profile?.currentPatrolId, patrolTracker.elapsedSeconds]);

  if (authLoading) {
    return (
      <div className="loading-screen">
        <div className="loader-orb" />
        <p>Loading Patrol Hub...</p>
      </div>
    );
  }

  if (!authUser) {
    return <AuthScreen onLogin={handleLogin} onRegister={handleRegister} />;
  }

  if (!profile) {
    return (
      <div className="loading-screen">
        <div className="loader-orb" />
        <p>Loading your account...</p>
      </div>
    );
  }

  if (!profile.approved) {
    return (
      <div className="pending-screen">
        <GlassCard className="pending-card">
          <span className="eyebrow">Pending approval</span>
          <h1>{getUserDisplayName(profile)}, your account has been created.</h1>
          <p>
            An admin still needs to approve it before you can access tracking, live patrols, the board, and route tools.
          </p>
          <div className="pending-actions">
            <button className="primary-button" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <ToastStack items={toasts} />

      <header className="topbar glass-card">
        <div>
          <span className="eyebrow">Patrol Hub</span>
          <h1>Live patrol command view</h1>
        </div>

        <div className="topbar-actions">
          <button className="ghost-button" onClick={requestNotificationPermission}>
            <Bell size={16} />
            {notificationPermission === 'unsupported'
              ? 'Notifications unavailable'
              : notificationPermission === 'granted'
                ? 'Notifications on'
                : notificationPermission === 'denied'
                  ? 'Notifications blocked'
                  : 'Enable notifications'}
          </button>
          <button className="ghost-button" onClick={handleLogout}>
            <LogOut size={16} />
            Log out
          </button>
        </div>
      </header>

      <nav className="tab-row">
        <TabButton active={tab === 'patrol'} onClick={() => setTab('patrol')} icon={<MapPinned size={16} />} label="Patrol center" />
        <TabButton
          active={tab === 'board'}
          onClick={() => setTab('board')}
          icon={<MessageSquare size={16} />}
          label={`Board${unreadMentions ? ` (${unreadMentions})` : ''}`}
        />
        {profile.role === 'admin' ? (
          <TabButton active={tab === 'admin'} onClick={() => setTab('admin')} icon={<ShieldCheck size={16} />} label="Admin" />
        ) : null}
      </nav>

      {tab === 'patrol' ? (
        <div className="dashboard-grid">
          <div className="dashboard-main">
            <GlassCard
              title="Patrol controls"
              subtitle="Start patrol only after GPS/location is enabled. The map still works for viewing other patrollers even if your GPS is off."
            >
              <div className="stat-row">
                <StatPill label="Status" value={patrolTracker.tracking ? 'Active patrol' : 'Idle'} />
                <StatPill label="Time tracked" value={formatDuration(patrolTracker.elapsedSeconds)} />
                <StatPill label="GPS permission" value={patrolTracker.gpsPermission} />
              </div>

              {patrolTracker.gpsWarning ? (
                <div className="warning-banner">{patrolTracker.gpsWarning}</div>
              ) : null}

              {patrolTracker.tracking && pageVisibility !== 'visible' ? (
                <div className="info-banner">
                  <TriangleAlert size={16} />
                  <span>Tracking may pause while the browser is in the background, the phone is locked, or the tab is suspended.</span>
                </div>
              ) : null}

              <div className="action-row action-row--wrap">
                {!patrolTracker.tracking ? (
                  <button className="primary-button" onClick={patrolTracker.startPatrol} disabled={patrolTracker.patrolBusy}>
                    <Compass size={18} />
                    Start patrol
                  </button>
                ) : (
                  <button className="danger-button" onClick={patrolTracker.endPatrol} disabled={patrolTracker.patrolBusy}>
                    <CheckCircle2 size={18} />
                    End patrol
                  </button>
                )}

                <button className="ghost-button danger-outline" onClick={patrolTracker.requestAssistance} disabled={patrolTracker.patrolBusy}>
                  <Siren size={18} />
                  Request assistance
                </button>
              </div>
            </GlassCard>

            <GlassCard
              title="Shared live map"
              subtitle="Your marker, active patrollers, active assistance alerts, and saved planned routes are shown together."
            >
              <MapPanel
                profile={profile}
                activePatrollers={activePatrollers}
                alerts={alerts}
                plannedRoutes={plannedRoutes}
                viewerRoute={patrolTracker.viewerRoute}
                selectedPatrollerRoute={historyRoutePoints.length ? historyRoutePoints : selectedPatrollerRoute}
                draftRoutePoints={draftRoutePoints}
                draftRouteAnchors={draftRouteAnchors}
                drawMode={drawMode}
                focusedUser={focusedUser}
                onAddDraftPoint={addDraftRouteStop}
              />
            </GlassCard>

            <GlassCard
              title="Route planner"
              subtitle="Turn draw mode on, tap a start point, then tap major turns or a destination. The planner now tries to snap each segment onto nearby streets."
            >
              <div className="route-tools">
                <label>
                  Route name
                  <input value={draftRouteName} onChange={(event) => setDraftRouteName(event.target.value)} />
                </label>

                <div className="action-row action-row--wrap">
                  <button className={drawMode ? 'primary-button' : 'ghost-button'} onClick={() => setDrawMode((value) => !value)}>
                    {drawMode ? 'Drawing on' : 'Enable draw mode'}
                  </button>
                  <button className="ghost-button" onClick={() => {
                    setDraftRouteAnchors((current) => current.slice(0, -1));
                    setDraftRouteSegments((current) => current.slice(0, -1));
                  }} disabled={!draftRouteAnchors.length}>
                    Undo last stop
                  </button>
                  <button className="ghost-button" onClick={() => {
                    setDraftRouteAnchors([]);
                    setDraftRouteSegments([]);
                  }} disabled={!draftRouteAnchors.length}>
                    Clear draft
                  </button>
                  <button className="primary-button" onClick={savePlannedRoute} disabled={routeBusy || draftRoutePoints.length < 2}>
                    {routeBusy ? 'Working...' : 'Save planned route'}
                  </button>
                </div>
                <small>{draftRouteAnchors.length} stop(s) selected · {draftRoutePoints.length} road points in the current draft route.</small>
              </div>
            </GlassCard>

            <GlassCard
              title="Patrol history"
              subtitle="This is where you view previous routes and your tracked time totals for today, this month, and this year."
            >
              <div className="route-tools">
                <div className="stat-row">
                  <StatPill label="Today" value={formatDuration(patrolSummary.day)} />
                  <StatPill label="This month" value={formatDuration(patrolSummary.month)} />
                  <StatPill label="This year" value={formatDuration(patrolSummary.year)} />
                </div>

                <div className="stack-list compact-list">
                  {patrolHistory.length ? (
                    patrolHistory.slice(0, 12).map((patrol) => {
                      const duration =
                        patrol.active && profile.currentPatrolId === patrol.id
                          ? patrolTracker.elapsedSeconds
                          : patrol.durationSeconds ?? 0;

                      return (
                        <div
                          key={patrol.id}
                          className={`alert-card ${historyRoutePatrolId === patrol.id ? 'history-card--active' : ''}`}
                        >
                          <div>
                            <strong>{formatPatrolDateTime(patrol.startedAt)}</strong>
                            <p>
                              {patrol.active
                                ? 'Patrol still active'
                                : patrol.endedAt
                                  ? `Ended ${formatPatrolDateTime(patrol.endedAt)}`
                                  : 'Patrol completed'}
                            </p>
                            <span>{formatDuration(duration)}</span>
                          </div>
                          <div className="action-row action-row--wrap">
                            <button
                              className="ghost-button"
                              onClick={() => {
                                if (historyRoutePatrolId === patrol.id) {
                                  setHistoryRoutePatrolId(null);
                                  return;
                                }

                                setSelectedPatroller(null);
                                setHistoryRoutePatrolId(patrol.id);
                              }}
                            >
                              {historyRoutePatrolId === patrol.id ? 'Hide route' : 'Show route'}
                            </button>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="empty-state">No saved patrols yet. Start and end a patrol to begin building route history.</div>
                  )}
                </div>
              </div>
            </GlassCard>
          </div>

          <div className="dashboard-side">
            <GlassCard title="Active patrollers" subtitle="Click a patroller to focus the map on their live location.">
              <div className="stack-list">
                {activePatrollers.length ? (
                  activePatrollers.map((user) => (
                    <button
                      key={user.uid}
                      className={`stack-item ${selectedPatroller?.uid === user.uid ? 'stack-item--active' : ''}`}
                      onClick={() => {
                        setHistoryRoutePatrolId(null);
                        setSelectedPatroller(user);
                      }}
                    >
                      <div className="stack-item__avatar" style={{ background: user.avatarColor }}>
                        {getUserDisplayName(user).slice(0, 1).toUpperCase()}
                      </div>
                      <div className="stack-item__content">
                        <strong>{getUserDisplayName(user)}</strong>
                        <span>
                          {user.uid === profile.uid
                            ? 'You'
                            : (() => {
                                const status = getPatrollerTrackingStatus(user);
                                return status.paused ? `${status.label} · ${status.detail}` : status.detail;
                              })()}
                        </span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="empty-state">No active patrollers right now.</div>
                )}
              </div>
            </GlassCard>

            <GlassCard title="Assistance alerts" subtitle="Everyone connected sees these immediately. Background push can be added later with a server-side sender.">
              <div className="stack-list compact-list">
                {alerts.length ? (
                  alerts.map((alert) => (
                    <div key={alert.id} className="alert-card">
                      <div>
                        <strong>{alert.username}</strong>
                        <p>{alert.message}</p>
                        <span>{formatTimeAgo(alert.createdAt)}</span>
                      </div>
                      <div className="action-row action-row--wrap">
                        {alert.location ? (
                          <a className="ghost-button" href={googleMapsDirectionsUrl(alert.location.lat, alert.location.lng)} target="_blank" rel="noreferrer">
                            Directions
                          </a>
                        ) : null}
                        {profile.role === 'admin' || alert.createdBy === profile.uid ? (
                          <button className="ghost-button" onClick={() => resolveAlert(alert.id)}>
                            Resolve
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">No open alerts.</div>
                )}
              </div>
            </GlassCard>

            <GlassCard title="Quick notes" subtitle="What this first version already does.">
              <ul className="feature-list">
                <li>Admin-approved accounts</li>
                <li>Live patrol start/end tracking</li>
                <li>Time tracked and route points saved</li>
                <li>Shared map with active patrollers</li>
                <li>Assistance requests with directions links</li>
                <li>Planned route plotting</li>
                <li>Message board with smart @name mentions</li>
                <li>Session stays signed in on the same device</li>
                <li>Patrol resumes after accidental reopen</li>
              </ul>
            </GlassCard>
          </div>
        </div>
      ) : null}

      {tab === 'board' ? (
        <div className="board-grid">
          <GlassCard title="Message board" subtitle="Type @ and pick a person by name. Mentioned users get an in-app alert and a browser notification if permission is enabled.">
            <div className="board-composer">
              <textarea
                ref={postComposerRef}
                rows={5}
                value={postInput}
                onChange={(event) => handlePostInputChange(event.target.value, event.target.selectionStart)}
                onClick={(event) => syncMentionDraft(event.currentTarget.value, event.currentTarget.selectionStart)}
                onKeyUp={(event) => syncMentionDraft(event.currentTarget.value, event.currentTarget.selectionStart)}
                onKeyDown={handleComposerKeyDown}
                placeholder="Share patrol updates, route changes, or notes for the team. Example: @Brandon Lafford Please cover the south gate."
              />
              {mentionSuggestions.length ? (
                <div className="mention-suggestions">
                  <span className="mention-suggestions__label">Tag someone</span>
                  <div className="mention-suggestions__list">
                    {mentionSuggestions.map((user, index) => (
                      <button
                        key={user.uid}
                        type="button"
                        className={`mention-suggestion ${index === selectedMentionIndex ? 'mention-suggestion--active' : ''}`}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          insertMention(user);
                        }}
                      >
                        <strong>{getUserDisplayName(user)}</strong>
                        <span>{user.uid === profile.uid ? 'You' : 'Tap to insert mention'}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="action-row action-row--wrap">
                <button className="primary-button" onClick={submitPost} disabled={boardBusy || !postInput.trim()}>
                  Publish post
                </button>
              </div>
            </div>
          </GlassCard>

          <GlassCard title="Mentions" subtitle="Unread mention items are shown first.">
            <div className="stack-list compact-list">
              {mentions.length ? (
                mentions.map((mention) => (
                  <button key={mention.id} className={`mention-item ${mention.read ? '' : 'mention-item--unread'}`} onClick={() => markMentionRead(mention)}>
                    <strong>{mention.fromUsername}</strong>
                    <span>{mention.read ? 'Read' : 'Unread'} · {formatTimeAgo(mention.createdAt)}</span>
                  </button>
                ))
              ) : (
                <div className="empty-state">No mentions yet.</div>
              )}
            </div>
          </GlassCard>

          <GlassCard title="Posts" subtitle="Newest posts appear first.">
            <div className="posts-list">
              {posts.length ? (
                posts.map((post) => (
                  <article key={post.id} className="post-card">
                    <header>
                      <strong>{post.username}</strong>
                      <span>{formatTimeAgo(post.createdAt)}</span>
                    </header>
                    <div
                      className="post-card__content"
                      dangerouslySetInnerHTML={{ __html: highlightMentions(post.content, mentionableUsers) }}
                    />
                  </article>
                ))
              ) : (
                <div className="empty-state">No posts yet.</div>
              )}
            </div>
          </GlassCard>
        </div>
      ) : null}

      {tab === 'admin' && profile.role === 'admin' ? (
        <div className="admin-grid">
          <GlassCard title="Pending approvals" subtitle="Approve new users or approve and promote them to admin.">
            <div className="stack-list">
              {pendingUsers.length ? (
                pendingUsers.map((user) => (
                  <div key={user.uid} className="pending-user-card">
                    <div>
                      <strong>{getUserDisplayName(user)}</strong>
                      <p>{user.email}</p>
                    </div>
                    <div className="action-row action-row--wrap">
                      <button className="primary-button" onClick={() => approveUser(user.uid)}>
                        Approve
                      </button>
                      <button className="ghost-button" onClick={() => promoteUser(user.uid)}>
                        Approve + admin
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">No pending accounts.</div>
              )}
            </div>
          </GlassCard>
        </div>
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button className={`tab-button ${active ? 'tab-button--active' : ''}`} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default App;
