import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

type Screen = "today" | "route" | "visit" | "order" | "sync" | "profile";
type VisitStatus = "planned" | "active" | "completed";
type Session = { token: string; expiresAt: string; employee: { id: string; name: string; code: string } };
type QueueItem = { id: string; label: string; state: "failed" | "confirmed" };
type Outlet = {
  routeId: string;
  id: string;
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  sequence: number;
  status: VisitStatus;
  notes: string;
};
type PersistedState = { session: Session | null; shiftActive: boolean; outlets: Outlet[]; queue: QueueItem[] };

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fieldops.sherazwaqar.tech/api/v1";
export const STORAGE_KEY = "fieldops-production-state-v1";

function operationId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseState(saved: string): PersistedState | null {
  try {
    const value = JSON.parse(saved) as PersistedState;
    if (!value || !Array.isArray(value.outlets) || !Array.isArray(value.queue) || typeof value.shiftActive !== "boolean") return null;
    return value;
  } catch { return null; }
}

async function jsonRequest(path: string, options: RequestInit = {}, token?: string) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The FieldOPS server could not complete this request.");
  return body;
}

export default function FieldOpsApp() {
  const [hydrated, setHydrated] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [screen, setScreen] = useState<Screen>("today");
  const [shiftActive, setShiftActive] = useState(false);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [visitId, setVisitId] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [outcome, setOutcome] = useState("Order placed");
  const [notes, setNotes] = useState("");
  const [quantity, setQuantity] = useState("5");
  const [orderAmount, setOrderAmount] = useState(0);
  const [photo, setPhoto] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const selected = outlets.find((outlet) => outlet.id === selectedId) ?? outlets[0];
  const completed = outlets.filter((outlet) => outlet.status === "completed").length;
  const pending = queue.filter((item) => item.state === "failed").length;
  const nextOutlet = useMemo(() => outlets.find((outlet) => outlet.status !== "completed") ?? outlets[0], [outlets]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (!saved) return;
      const value = parseState(saved);
      if (!value) return;
      setSession(value.session); setShiftActive(value.shiftActive); setOutlets(value.outlets); setQueue(value.queue);
      if (value.outlets[0]) setSelectedId(value.outlets[0].id);
    }).finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ session, shiftActive, outlets, queue })).catch(() => undefined);
  }, [hydrated, outlets, queue, session, shiftActive]);

  useEffect(() => { if (hydrated && session) refreshRoute(false).catch(() => undefined); }, [hydrated, session?.token]);

  useEffect(() => {
    if (!hydrated || !session) return;
    const timer = setInterval(() => { refreshRoute(false).catch(() => undefined); }, 60_000);
    return () => clearInterval(timer);
  }, [hydrated, session?.token]);

  const addQueue = (label: string, state: QueueItem["state"]) => setQueue((items) => [{ id: operationId("event"), label, state }, ...items].slice(0, 50));

  async function refreshRoute(showMessage = true) {
    if (!session) return;
    setRefreshing(true);
    try {
      const context = await jsonRequest("/context", {}, session.token);
      setOutlets(context.route);
      setShiftActive(Boolean(context.shiftActive));
      setSelectedId((current) => context.route.some((item: Outlet) => item.id === current) ? current : (context.route[0]?.id ?? ""));
      if (showMessage) Alert.alert("Route refreshed", `${context.route.length} assigned stores downloaded.`);
    } catch (error) {
      if (showMessage) Alert.alert("Using downloaded route", error instanceof Error ? error.message : "Could not refresh.");
    } finally { setRefreshing(false); }
  }

  async function signIn(email: string, password: string) {
    const result = await jsonRequest("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    setSession(result); setScreen("today");
  }

  async function gps(accuracy = Location.Accuracy.High) {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== "granted") throw new Error("Location permission is required for field evidence.");
    return Location.getCurrentPositionAsync({ accuracy });
  }

  async function toggleShift() {
    if (!session) return;
    try {
      const point = await gps(Location.Accuracy.Balanced);
      const action = shiftActive ? "check_out" : "check_in";
      await jsonRequest("/attendance", { method: "POST", body: JSON.stringify({
        action, latitude: point.coords.latitude, longitude: point.coords.longitude, accuracy: point.coords.accuracy ?? 0,
        idempotencyKey: operationId(action),
      }) }, session.token);
      setShiftActive(!shiftActive); addQueue(`Shift ${shiftActive ? "check-out" : "check-in"}`, "confirmed");
    } catch (error) { addQueue("Shift event needs retry", "failed"); Alert.alert("Shift not saved", error instanceof Error ? error.message : "Try again."); }
  }

  async function startVisit(outlet: Outlet) {
    if (!session) return;
    if (!shiftActive) { Alert.alert("Check in first", "Start your shift before beginning an outlet visit."); return; }
    try {
      const point = await gps();
      const result = await jsonRequest("/visits/check-in", { method: "POST", body: JSON.stringify({
        outletId: outlet.id, routeId: outlet.routeId, latitude: point.coords.latitude, longitude: point.coords.longitude,
        accuracy: point.coords.accuracy ?? 0, capturedAt: new Date(point.timestamp).toISOString(), idempotencyKey: operationId("visit"),
      }) }, session.token);
      setVisitId(result.visitId); setSelectedId(outlet.id);
      setOutlets((items) => items.map((item) => item.id === outlet.id ? { ...item, status: "active" } : item));
      setPhoto(null); setAudioUri(null); setNotes(""); setOrderAmount(0); setScreen("visit");
      addQueue(`${outlet.name} GPS check-in · ${result.distanceMeters}m`, "confirmed");
      if (!result.geofenceAccepted) Alert.alert("Outside outlet geofence", `The point was saved ${result.distanceMeters}m from the assigned outlet. Management can review it.`);
    } catch (error) { addQueue(`${outlet.name} check-in needs retry`, "failed"); Alert.alert("Visit not started", error instanceof Error ? error.message : "Try again."); }
  }

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) { Alert.alert("Camera permission required", "Allow camera access to attach visit evidence."); return; }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    if (!result.canceled) setPhoto(result.assets[0]);
  }

  async function toggleRecording() {
    if (recording) {
      await recording.stopAndUnloadAsync(); setAudioUri(recording.getURI()); setRecording(null); return;
    }
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) { Alert.alert("Microphone permission required", "Allow microphone access to record an audio note."); return; }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const created = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    setRecording(created.recording);
  }

  async function finishVisit() {
    if (!session || !selected || !visitId) { Alert.alert("Start the visit first", "GPS check-in must be confirmed before completion."); return; }
    try {
      const point = await gps();
      const form = new FormData();
      form.append("outcome", outcome); form.append("notes", notes); form.append("orderAmount", String(orderAmount));
      form.append("latitude", String(point.coords.latitude)); form.append("longitude", String(point.coords.longitude));
      form.append("accuracy", String(point.coords.accuracy ?? 0)); form.append("capturedAt", new Date(point.timestamp).toISOString());
      if (photo) form.append("photo", { uri: photo.uri, name: photo.fileName ?? `visit-${visitId}.jpg`, type: photo.mimeType ?? "image/jpeg" } as never);
      if (audioUri) form.append("audio", { uri: audioUri, name: `visit-${visitId}.m4a`, type: "audio/m4a" } as never);
      const response = await fetch(`${API_BASE}/visits/${visitId}/complete`, { method: "POST", headers: { authorization: `Bearer ${session.token}` }, body: form });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Visit upload failed.");
      setOutlets((items) => items.map((item) => item.id === selected.id ? { ...item, status: "completed" } : item));
      addQueue(`${selected.name} completed · ${body.evidenceCount} evidence files`, "confirmed");
      setVisitId(""); setPhoto(null); setAudioUri(null); setScreen("route");
    } catch (error) { addQueue(`${selected.name} completion needs retry`, "failed"); Alert.alert("Visit kept on this phone", error instanceof Error ? error.message : "Reconnect and try again."); }
  }

  function saveOrder() {
    const kilograms = Number(quantity);
    if (!Number.isFinite(kilograms) || kilograms <= 0) { Alert.alert("Enter a quantity", "Quantity must be greater than zero."); return; }
    setOrderAmount(kilograms * 450); setOutcome("Order placed"); setScreen("visit");
    Alert.alert("Order attached", `PKR ${(kilograms * 450).toLocaleString()} will be saved when the visit is completed.`);
  }

  function moveOutlet(id: string, direction: -1 | 1) {
    setOutlets((items) => {
      const index = items.findIndex((item) => item.id === id), target = index + direction;
      if (index < 0 || target < 0 || target >= items.length) return items;
      const copy = [...items]; [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy.map((item, position) => ({ ...item, sequence: position + 1 }));
    });
  }

  if (!hydrated) return <SafeAreaView style={styles.safe}><View style={styles.loading}><Text style={styles.title}>Loading FieldOPS…</Text></View></SafeAreaView>;
  if (!session) return <Login onSubmit={signIn} />;

  return <SafeAreaView style={styles.safe}><View style={styles.app}><ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Header pending={pending} refreshing={refreshing} onSync={() => setScreen("sync")} onRefresh={() => refreshRoute()} />
    {screen === "today" && <Today shiftActive={shiftActive} completed={completed} total={outlets.length} nextOutlet={nextOutlet} onShift={toggleShift} onStart={() => nextOutlet && startVisit(nextOutlet)} onRoute={() => setScreen("route")} />}
    {screen === "route" && <Route outlets={outlets} onSelect={(id) => { setSelectedId(id); setScreen("visit"); }} onMove={moveOutlet} />}
    {screen === "visit" && selected && <Visit outlet={selected} activeVisit={Boolean(visitId)} outcome={outcome} setOutcome={setOutcome} notes={notes} setNotes={setNotes} photo={photo} audioUri={audioUri} recording={Boolean(recording)} orderAmount={orderAmount} onStart={() => startVisit(selected)} onPhoto={takePhoto} onAudio={toggleRecording} onOrder={() => setScreen("order")} onFinish={finishVisit} />}
    {screen === "order" && selected && <Order outlet={selected} quantity={quantity} setQuantity={setQuantity} onSubmit={saveOrder} />}
    {screen === "sync" && <SyncQueue queue={queue} onRefresh={() => refreshRoute()} />}
    {screen === "profile" && <Profile session={session} shiftActive={shiftActive} pending={pending} onLogout={() => { setSession(null); setOutlets([]); setQueue([]); setScreen("today"); }} />}
  </ScrollView><Nav screen={screen} setScreen={setScreen} /></View></SafeAreaView>;
}

function Login({ onSubmit }: { onSubmit: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false);
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.loginPage} keyboardShouldPersistTaps="handled"><View style={styles.loginBrand}><Text style={styles.loginMark}>YR</Text><Text style={styles.loginTitle}>Yousuf Rice FieldOps</Text><Text style={styles.loginBody}>Your assigned stores, route, GPS evidence, photos, audio notes, and visit outcomes.</Text></View><View style={styles.loginCard}><Text style={styles.eyebrow}>FIELD TEAM SIGN IN</Text><TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" placeholder="Work email" /><TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" placeholder="Password" /><Button label={busy ? "Signing in…" : "Sign in"} disabled={busy} onPress={async () => { setBusy(true); try { await onSubmit(email.trim(), password); } catch (error) { Alert.alert("Sign in failed", error instanceof Error ? error.message : "Try again."); } finally { setBusy(false); } }} /></View></ScrollView></SafeAreaView>;
}

function Header({ pending, refreshing, onSync, onRefresh }: { pending: number; refreshing: boolean; onSync: () => void; onRefresh: () => void }) { return <View style={styles.header}><View><Text style={styles.eyebrow}>YOUSUF RICE · FIELDOPS</Text><Text style={styles.title}>Today’s field route</Text></View><View style={styles.headerActions}><TouchableOpacity style={styles.refreshPill} onPress={onRefresh}><Text style={styles.refreshText}>{refreshing ? "…" : "Refresh"}</Text></TouchableOpacity><TouchableOpacity style={styles.syncPill} onPress={onSync}><Text style={styles.syncText}>{pending} pending</Text></TouchableOpacity></View></View>; }

function Today({ shiftActive, completed, total, nextOutlet, onShift, onStart, onRoute }: { shiftActive: boolean; completed: number; total: number; nextOutlet?: Outlet; onShift: () => void; onStart: () => void; onRoute: () => void }) { return <><View style={styles.shiftCard}><View><Text style={styles.darkLabel}>TODAY · ASSIGNED ROUTE</Text><Text style={styles.shiftValue}>{shiftActive ? "Shift in progress" : "Not checked in"}</Text></View><Button label={shiftActive ? "Check out" : "Check in"} onPress={onShift} /></View><Text style={styles.sectionTitle}>Today’s work</Text><View style={styles.stats}><Stat value={`${completed}/${total}`} label="Visits" /><Stat value={`${Math.max(0, total - completed)}`} label="Remaining" /><Stat value={shiftActive ? "Live" : "Stopped"} label="GPS evidence" /></View>{nextOutlet ? <View style={styles.hero}><Text style={styles.heroKicker}>NEXT VISIT · STOP {nextOutlet.sequence}</Text><Text style={styles.heroTitle}>{nextOutlet.name}</Text><Text style={styles.heroBody}>{nextOutlet.address}</Text><View style={styles.actionRow}><Button label="Start visit" onPress={onStart} /><GhostButton label="Full route" onPress={onRoute} /></View></View> : <View style={styles.empty}><Text style={styles.cardTitle}>No route assigned</Text><Text style={styles.noticeBody}>Ask management to assign stores, then tap Refresh.</Text></View>}<View style={styles.notice}><Text style={styles.noticeTitle}>Server-connected & offline-readable</Text><Text style={styles.noticeBody}>Assigned routes stay downloaded on this phone. Confirmed appears only after the server saves the event.</Text></View></>; }

function Route({ outlets, onSelect, onMove }: { outlets: Outlet[]; onSelect: (id: string) => void; onMove: (id: string, direction: -1 | 1) => void }) { return <><Text style={styles.screenTitle}>Choose your route</Text><Text style={styles.lede}>Management assigns the stores; you choose what to complete first. Use the arrows, then tap a store.</Text><RouteMap outlets={outlets} />{outlets.map((outlet, index) => <View key={outlet.id} style={styles.listRow}><Text style={styles.index}>{String(index + 1).padStart(2, "0")}</Text><TouchableOpacity style={styles.grow} onPress={() => onSelect(outlet.id)}><Text style={styles.rowTitle}>{outlet.name}</Text><Text style={styles.rowMeta}>{outlet.address}</Text></TouchableOpacity><View style={styles.reorder}><TouchableOpacity disabled={index === 0} onPress={() => onMove(outlet.id, -1)}><Text style={[styles.arrow, index === 0 && styles.arrowDisabled]}>↑</Text></TouchableOpacity><TouchableOpacity disabled={index === outlets.length - 1} onPress={() => onMove(outlet.id, 1)}><Text style={[styles.arrow, index === outlets.length - 1 && styles.arrowDisabled]}>↓</Text></TouchableOpacity></View><Status status={outlet.status} /></View>)}</>; }

function RouteMap({ outlets }: { outlets: Outlet[] }) { const points = JSON.stringify(outlets.map((outlet) => ({ name: outlet.name, address: outlet.address, lat: outlet.latitude, lng: outlet.longitude }))).replaceAll("<", "\\u003c"); const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" rel="stylesheet"><style>html,body,#map{height:100%;margin:0}.maplibregl-popup-content{font:12px system-ui;color:#17233b}</style></head><body><div id="map"></div><script src="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"></script><script>const points=${points};const map=new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/liberty',center:[67.035,24.815],zoom:11.8});const bounds=new maplibregl.LngLatBounds();points.forEach((p,i)=>{new maplibregl.Marker({color:'#243d74'}).setLngLat([p.lng,p.lat]).setPopup(new maplibregl.Popup().setText((i+1)+'. '+p.name+' · '+p.address)).addTo(map);bounds.extend([p.lng,p.lat])});map.on('load',()=>{if(points.length>1){map.addSource('planned-order',{type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:points.map(p=>[p.lng,p.lat])}}});map.addLayer({id:'planned-order',type:'line',source:'planned-order',paint:{'line-color':'#d8a629','line-width':4,'line-opacity':.82}})}});if(points.length>1)map.fitBounds(bounds,{padding:35,maxZoom:14,duration:0});</script></body></html>`; return <View style={styles.mapWrap}><WebView source={{ html }} originWhitelist={["*"]} javaScriptEnabled /></View>; }

function Visit({ outlet, activeVisit, outcome, setOutcome, notes, setNotes, photo, audioUri, recording, orderAmount, onStart, onPhoto, onAudio, onOrder, onFinish }: { outlet: Outlet; activeVisit: boolean; outcome: string; setOutcome: (value: string) => void; notes: string; setNotes: (value: string) => void; photo: ImagePicker.ImagePickerAsset | null; audioUri: string | null; recording: boolean; orderAmount: number; onStart: () => void; onPhoto: () => void; onAudio: () => void; onOrder: () => void; onFinish: () => void }) { const outcomes = ["Order placed", "No order", "Shop closed", "Owner unavailable"]; return <><Text style={styles.screenTitle}>{outlet.name}</Text><Text style={styles.lede}>{outlet.address}</Text><View style={styles.card}><Text style={styles.eyebrow}>VISIT STATUS</Text><Text style={styles.cardTitle}>{activeVisit ? "Visit in progress" : outlet.status === "completed" ? "Visit completed" : "Ready for GPS check-in"}</Text>{!activeVisit && outlet.status !== "completed" && <Button label="GPS check in" onPress={onStart} />}</View>{activeVisit && <><Text style={styles.sectionTitle}>Visit outcome</Text><View style={styles.choiceWrap}>{outcomes.map((item) => <TouchableOpacity key={item} style={[styles.choice, outcome === item && styles.choiceSelected]} onPress={() => setOutcome(item)}><Text style={[styles.choiceText, outcome === item && styles.choiceTextSelected]}>{item}</Text></TouchableOpacity>)}</View><TextInput style={[styles.input, styles.notes]} value={notes} onChangeText={setNotes} placeholder="Visit notes" multiline /><View style={styles.evidenceRow}><EvidenceButton label={photo ? "Retake photo" : "Take photo"} active={Boolean(photo)} onPress={onPhoto} /><EvidenceButton label={recording ? "Stop recording" : audioUri ? "Record again" : "Audio note"} active={Boolean(audioUri || recording)} onPress={onAudio} /></View>{photo && <Image source={{ uri: photo.uri }} style={styles.photoPreview} />}{audioUri && <Text style={styles.confirmedLine}>Audio note ready to upload</Text>}{orderAmount > 0 && <Text style={styles.confirmedLine}>Order attached · PKR {orderAmount.toLocaleString()}</Text>}<View style={styles.actionRow}><Button label="Create order" onPress={onOrder} /><GhostButton dark label="Finish & upload" onPress={onFinish} /></View></>}</>; }

function Order({ outlet, quantity, setQuantity, onSubmit }: { outlet: Outlet; quantity: string; setQuantity: (value: string) => void; onSubmit: () => void }) { const total = Math.max(0, Number(quantity) || 0) * 450; return <><Text style={styles.screenTitle}>Fast order</Text><Text style={styles.lede}>{outlet.name}</Text><View style={styles.card}><Text style={styles.inputLabel}>PRODUCT</Text><Text style={styles.cardTitle}>Yousuf Super Kernel Basmati</Text><Text style={styles.rowMeta}>Trade price · PKR 450/kg</Text><Text style={styles.inputLabel}>QUANTITY (KG)</Text><TextInput style={styles.input} value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" /><View style={styles.totalRow}><Text style={styles.totalLabel}>Order total</Text><Text style={styles.total}>PKR {total.toLocaleString()}</Text></View><Button label="Attach to visit" onPress={onSubmit} /></View></>; }

function SyncQueue({ queue, onRefresh }: { queue: QueueItem[]; onRefresh: () => void }) { const failed = queue.filter((item) => item.state === "failed").length; return <><Text style={styles.screenTitle}>Server activity</Text><Text style={styles.lede}>Confirmed means the server saved the record. Failed items remain visible so they are never mistaken for synced data.</Text>{failed > 0 && <Button label="Refresh & retry route" onPress={onRefresh} />}{queue.length === 0 ? <View style={styles.empty}><Text style={styles.cardTitle}>Nothing recorded yet</Text><Text style={styles.noticeBody}>Shift and visit events will appear here.</Text></View> : queue.map((item) => <View key={item.id} style={styles.listRow}><View style={[styles.dot, item.state === "confirmed" && styles.dotConfirmed]} /><View style={styles.grow}><Text style={styles.rowTitle}>{item.label}</Text><Text style={styles.rowMeta}>{item.state === "confirmed" ? "Saved by server" : "Needs retry"}</Text></View></View>)}</>; }

function Profile({ session, shiftActive, pending, onLogout }: { session: Session; shiftActive: boolean; pending: number; onLogout: () => void }) { return <><Text style={styles.screenTitle}>Field profile</Text><View style={styles.card}><Text style={styles.eyebrow}>SALES REPRESENTATIVE</Text><Text style={styles.cardTitle}>{session.employee.name}</Text><Text style={styles.lede}>Employee code {session.employee.code}</Text></View><View style={styles.card}><Text style={styles.cardTitle}>Tracking & privacy</Text><Text style={styles.noticeBody}>Location is captured at shift and visit events. Photos and audio are uploaded only when you finish a visit.</Text><Text style={styles.profileLine}>Shift tracking: {shiftActive ? "Active" : "Stopped"}</Text><Text style={styles.profileLine}>Records needing attention: {pending}</Text></View><GhostButton dark label="Sign out" onPress={onLogout} /></>; }

function Nav({ screen, setScreen }: { screen: Screen; setScreen: (screen: Screen) => void }) { const items: { key: Screen; label: string }[] = [{ key: "today", label: "Today" }, { key: "route", label: "Route" }, { key: "sync", label: "Activity" }, { key: "profile", label: "Profile" }]; return <View style={styles.nav}>{items.map((item) => <TouchableOpacity key={item.key} style={styles.navItem} onPress={() => setScreen(item.key)}><Text style={[styles.navText, screen === item.key && styles.navActive]}>{item.label}</Text></TouchableOpacity>)}</View>; }
function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) { return <TouchableOpacity style={[styles.button, disabled && styles.disabled]} onPress={onPress} disabled={disabled}><Text style={styles.buttonText}>{label}</Text></TouchableOpacity>; }
function GhostButton({ label, onPress, dark = false }: { label: string; onPress: () => void; dark?: boolean }) { return <TouchableOpacity style={[styles.ghost, dark && styles.ghostDark]} onPress={onPress}><Text style={[styles.ghostText, dark && styles.ghostTextDark]}>{label}</Text></TouchableOpacity>; }
function EvidenceButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) { return <TouchableOpacity style={[styles.evidenceButton, active && styles.evidenceActive]} onPress={onPress}><Text style={styles.evidenceText}>{label}</Text></TouchableOpacity>; }
function Stat({ value, label }: { value: string; label: string }) { return <View><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>; }
function Status({ status }: { status: VisitStatus }) { return <Text style={[styles.status, status === "completed" && styles.statusDone, status === "active" && styles.statusActive]}>{status}</Text>; }

const navy = "#17233B", blue = "#243D74", gold = "#D8A629", paper = "#F7F8F4", line = "#DCE0D8", muted = "#697184";
const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:paper},app:{flex:1},page:{padding:20,paddingBottom:110,gap:18},loading:{flex:1,justifyContent:"center",alignItems:"center"},
  loginPage:{flexGrow:1,backgroundColor:navy,padding:24,justifyContent:"center",gap:26},loginBrand:{alignItems:"center"},loginMark:{width:62,height:62,borderRadius:18,backgroundColor:gold,color:navy,textAlign:"center",textAlignVertical:"center",fontSize:24,fontWeight:"900",paddingTop:16},loginTitle:{color:"white",fontSize:29,fontWeight:"900",marginTop:16},loginBody:{color:"#BAC4D8",textAlign:"center",lineHeight:21,maxWidth:360,marginTop:9},loginCard:{backgroundColor:"white",borderRadius:18,padding:20,gap:14},
  header:{flexDirection:"row",justifyContent:"space-between",alignItems:"flex-start",gap:12},headerActions:{flexDirection:"row",gap:6},eyebrow:{fontSize:10,fontWeight:"900",letterSpacing:1.1,color:muted},title:{fontSize:26,fontWeight:"800",color:navy,marginTop:4,maxWidth:240},syncPill:{backgroundColor:"#FFF1D0",paddingHorizontal:10,paddingVertical:7,borderRadius:99},syncText:{color:"#805C00",fontSize:11,fontWeight:"900"},refreshPill:{backgroundColor:"#E6ECF8",paddingHorizontal:10,paddingVertical:7,borderRadius:99},refreshText:{color:blue,fontSize:11,fontWeight:"900"},
  shiftCard:{backgroundColor:navy,borderRadius:16,padding:18,flexDirection:"row",justifyContent:"space-between",alignItems:"center",gap:12},darkLabel:{color:"#AAB3C5",fontSize:10,fontWeight:"900"},shiftValue:{color:"white",fontSize:16,fontWeight:"800",marginTop:4},button:{backgroundColor:gold,paddingHorizontal:17,paddingVertical:13,borderRadius:9,alignItems:"center"},disabled:{opacity:.55},buttonText:{fontWeight:"900",color:navy},
  sectionTitle:{fontSize:19,fontWeight:"900",color:navy,marginTop:5},stats:{flexDirection:"row",justifyContent:"space-between",borderTopWidth:1,borderBottomWidth:1,borderColor:line,paddingVertical:16},statValue:{fontSize:19,fontWeight:"900",color:navy},statLabel:{fontSize:11,color:muted,marginTop:3},
  hero:{backgroundColor:blue,borderRadius:16,padding:20},heroKicker:{fontSize:10,fontWeight:"900",letterSpacing:1,color:"#B6C2DF"},heroTitle:{fontSize:25,fontWeight:"900",color:"white",marginTop:10},heroBody:{color:"#C2CBE0",marginTop:6},actionRow:{flexDirection:"row",gap:10,marginTop:20,flexWrap:"wrap"},ghost:{borderWidth:1,borderColor:"#7081A8",paddingHorizontal:17,paddingVertical:12,borderRadius:9,alignItems:"center"},ghostDark:{borderColor:navy},ghostText:{color:"white",fontWeight:"900"},ghostTextDark:{color:navy},
  notice:{backgroundColor:"#E9EEE8",borderLeftWidth:4,borderLeftColor:"#267057",padding:16,borderRadius:8},noticeTitle:{fontWeight:"900",color:navy},noticeBody:{color:"#586273",lineHeight:20,marginTop:5},screenTitle:{fontSize:32,fontWeight:"900",color:navy},lede:{color:muted,lineHeight:20},
  mapWrap:{height:265,borderRadius:14,overflow:"hidden",borderWidth:1,borderColor:line},listRow:{flexDirection:"row",alignItems:"center",gap:10,paddingVertical:15,borderBottomWidth:1,borderColor:line},index:{width:28,color:"#9A7A23",fontWeight:"900"},grow:{flex:1},rowTitle:{color:navy,fontWeight:"800"},rowMeta:{color:muted,fontSize:12,marginTop:4},status:{fontSize:9,fontWeight:"900",color:muted,textTransform:"uppercase"},statusDone:{color:"#267057"},statusActive:{color:"#9A6300"},reorder:{flexDirection:"row",gap:7},arrow:{fontSize:20,color:blue,fontWeight:"900",padding:5},arrowDisabled:{color:"#C9CEC7"},
  card:{backgroundColor:"white",borderWidth:1,borderColor:line,borderRadius:14,padding:18,gap:13},cardTitle:{fontSize:21,fontWeight:"900",color:navy},choiceWrap:{flexDirection:"row",flexWrap:"wrap",gap:9},choice:{borderWidth:1,borderColor:line,borderRadius:99,paddingHorizontal:14,paddingVertical:10},choiceSelected:{backgroundColor:navy,borderColor:navy},choiceText:{color:navy,fontWeight:"700"},choiceTextSelected:{color:"white"},inputLabel:{fontSize:10,fontWeight:"900",color:muted,letterSpacing:1,marginTop:7},input:{borderWidth:1,borderColor:line,borderRadius:9,padding:13,fontSize:16,color:navy,backgroundColor:"white"},notes:{minHeight:88,textAlignVertical:"top"},
  evidenceRow:{flexDirection:"row",gap:10},evidenceButton:{flex:1,borderWidth:1,borderColor:line,borderRadius:10,padding:13,alignItems:"center",backgroundColor:"white"},evidenceActive:{backgroundColor:"#E9F5EF",borderColor:"#267057"},evidenceText:{color:navy,fontWeight:"800"},photoPreview:{width:"100%",height:220,borderRadius:12},confirmedLine:{backgroundColor:"#E9F5EF",color:"#205E49",fontWeight:"800",padding:11,borderRadius:8},
  totalRow:{borderTopWidth:1,borderColor:line,paddingTop:14,flexDirection:"row",justifyContent:"space-between"},totalLabel:{color:muted,fontWeight:"700"},total:{color:navy,fontSize:18,fontWeight:"900"},empty:{padding:30,backgroundColor:"#E9EEE8",borderRadius:12,alignItems:"center"},dot:{width:10,height:10,borderRadius:5,backgroundColor:"#C84D3A"},dotConfirmed:{backgroundColor:"#267057"},profileLine:{color:navy,fontWeight:"700",borderTopWidth:1,borderColor:line,paddingTop:12},
  nav:{position:"absolute",left:14,right:14,bottom:12,backgroundColor:navy,borderRadius:16,flexDirection:"row",padding:7},navItem:{flex:1,alignItems:"center",paddingVertical:11},navText:{color:"#9FAABD",fontSize:12,fontWeight:"800"},navActive:{color:gold},
});
