import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

type Screen = "today" | "route" | "visit" | "order" | "sync" | "profile";
type VisitStatus = "planned" | "active" | "completed";
type QueueItem = { id: string; label: string; state: "pending" | "confirmed" };
type Outlet = {
  id: string;
  name: string;
  address: string;
  time: string;
  distance: string;
  status: VisitStatus;
};

const STORAGE_KEY = "fieldops-pilot-state-v1";
const initialOutlets: Outlet[] = [
  { id: "rehman", name: "Rehman General Store", address: "Clifton Block 2", time: "09:10", distance: "1.2 km", status: "planned" },
  { id: "zamzama", name: "Zamzama Mart", address: "Zamzama Commercial", time: "10:05", distance: "2.4 km", status: "planned" },
  { id: "madina", name: "Al-Madina Traders", address: "Clifton Block 5", time: "11:20", distance: "3.1 km", status: "planned" },
  { id: "seaview", name: "Sea View Supermarket", address: "Sea View Road", time: "12:15", distance: "4.8 km", status: "planned" },
];

export default function FieldOpsApp() {
  const [screen, setScreen] = useState<Screen>("today");
  const [shiftActive, setShiftActive] = useState(false);
  const [outlets, setOutlets] = useState(initialOutlets);
  const [selectedId, setSelectedId] = useState(initialOutlets[0].id);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [outcome, setOutcome] = useState("Order placed");
  const [quantity, setQuantity] = useState("5");
  const [hydrated, setHydrated] = useState(false);

  const selected = outlets.find((outlet) => outlet.id === selectedId) ?? outlets[0];
  const completed = outlets.filter((outlet) => outlet.status === "completed").length;
  const pending = queue.filter((item) => item.state === "pending").length;

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (!saved) return;
        const state = JSON.parse(saved) as { shiftActive: boolean; outlets: Outlet[]; queue: QueueItem[] };
        setShiftActive(state.shiftActive);
        setOutlets(state.outlets);
        setQueue(state.queue);
      })
      .catch(() => undefined)
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ shiftActive, outlets, queue })).catch(() => undefined);
  }, [hydrated, outlets, queue, shiftActive]);

  const queueOperation = (label: string) => {
    setQueue((items) => [{ id: `${Date.now()}-${items.length}`, label, state: "pending" }, ...items]);
  };

  const toggleShift = async () => {
    if (!shiftActive) {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        Alert.alert("Location required", "Location evidence is required to check in for a field shift.");
        return;
      }
      await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setShiftActive(true);
      queueOperation("Shift check-in");
    } else {
      setShiftActive(false);
      queueOperation("Shift check-out");
    }
  };

  const startVisit = async () => {
    if (!shiftActive) {
      Alert.alert("Check in first", "Start your shift before beginning an outlet visit.");
      return;
    }
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== "granted") {
      Alert.alert("Location required", "Enable location to capture visit evidence.");
      return;
    }
    await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    setOutlets((items) => items.map((item) => item.id === selected.id ? { ...item, status: "active" } : item));
    queueOperation(`${selected.name} visit check-in`);
    setScreen("visit");
  };

  const finishVisit = () => {
    setOutlets((items) => items.map((item) => item.id === selected.id ? { ...item, status: "completed" } : item));
    queueOperation(`${selected.name}: ${outcome}`);
    setScreen("route");
  };

  const submitOrder = () => {
    const kilograms = Number(quantity);
    if (!Number.isFinite(kilograms) || kilograms <= 0) {
      Alert.alert("Enter a quantity", "Quantity must be greater than zero.");
      return;
    }
    queueOperation(`${selected.name} order · ${kilograms} kg · PKR ${(kilograms * 450).toLocaleString()}`);
    Alert.alert("Order saved", "The draft is stored on this phone and is pending server confirmation.", [
      { text: "Continue visit", onPress: () => setScreen("visit") },
    ]);
  };

  const syncNow = () => {
    setQueue((items) => items.map((item) => ({ ...item, state: "confirmed" })));
    Alert.alert("Pilot sync complete", "This pilot confirms records locally. Production sync will use the FieldOPS API.");
  };

  const nextOutlet = useMemo(
    () => outlets.find((outlet) => outlet.status !== "completed") ?? outlets[0],
    [outlets],
  );

  return <SafeAreaView style={styles.safe}>
    <View style={styles.app}>
      <ScrollView contentContainerStyle={styles.page}>
        <Header pending={pending} onSync={() => setScreen("sync")} />
        {screen === "today" && <Today
          shiftActive={shiftActive}
          completed={completed}
          nextOutlet={nextOutlet}
          onShift={toggleShift}
          onStart={() => { setSelectedId(nextOutlet.id); startVisit(); }}
          onRoute={() => setScreen("route")}
        />}
        {screen === "route" && <Route outlets={outlets} onSelect={(id) => { setSelectedId(id); setScreen("visit"); }} />}
        {screen === "visit" && <Visit outlet={selected} outcome={outcome} setOutcome={setOutcome} onStart={startVisit} onOrder={() => setScreen("order")} onFinish={finishVisit} />}
        {screen === "order" && <Order outlet={selected} quantity={quantity} setQuantity={setQuantity} onSubmit={submitOrder} />}
        {screen === "sync" && <SyncQueue queue={queue} onSync={syncNow} />}
        {screen === "profile" && <Profile shiftActive={shiftActive} pending={pending} />}
      </ScrollView>
      <Nav screen={screen} setScreen={setScreen} />
    </View>
  </SafeAreaView>;
}

function Header({ pending, onSync }: { pending: number; onSync: () => void }) {
  return <View style={styles.header}>
    <View><Text style={styles.eyebrow}>YOUSUF RICE · FIELDOPS PILOT</Text><Text style={styles.title}>Assalam-o-Alaikum, Ali</Text></View>
    <TouchableOpacity style={styles.syncPill} onPress={onSync}><Text style={styles.syncText}>{pending} pending</Text></TouchableOpacity>
  </View>;
}

function Today({ shiftActive, completed, nextOutlet, onShift, onStart, onRoute }: {
  shiftActive: boolean; completed: number; nextOutlet: Outlet; onShift: () => void; onStart: () => void; onRoute: () => void;
}) {
  return <>
    <View style={styles.shiftCard}><View><Text style={styles.darkLabel}>TODAY · CLIFTON BEAT</Text><Text style={styles.shiftValue}>{shiftActive ? "Shift in progress" : "Not checked in"}</Text></View><Button label={shiftActive ? "Check out" : "Check in"} onPress={onShift} /></View>
    <Text style={styles.sectionTitle}>Today’s work</Text>
    <View style={styles.stats}><Stat value={`${completed}/4`} label="Visits" /><Stat value="PKR 95k" label="Sales target" /><Stat value="08:30" label="Shift start" /></View>
    <View style={styles.hero}><Text style={styles.heroKicker}>NEXT VISIT · {nextOutlet.time}</Text><Text style={styles.heroTitle}>{nextOutlet.name}</Text><Text style={styles.heroBody}>{nextOutlet.address} · {nextOutlet.distance}</Text><View style={styles.actionRow}><Button label="Start visit" onPress={onStart} /><GhostButton label="Full route" onPress={onRoute} /></View></View>
    <View style={styles.notice}><Text style={styles.noticeTitle}>Offline-ready pilot</Text><Text style={styles.noticeBody}>Shift, visit, and order actions stay on this phone until they are confirmed by the server.</Text></View>
  </>;
}

function Route({ outlets, onSelect }: { outlets: Outlet[]; onSelect: (id: string) => void }) {
  return <><Text style={styles.screenTitle}>Today’s route</Text><Text style={styles.lede}>Tap an outlet to check in, record an outcome, or create an order.</Text>{outlets.map((outlet, index) => <TouchableOpacity key={outlet.id} style={styles.listRow} onPress={() => onSelect(outlet.id)}><Text style={styles.index}>{String(index + 1).padStart(2, "0")}</Text><View style={styles.grow}><Text style={styles.rowTitle}>{outlet.name}</Text><Text style={styles.rowMeta}>{outlet.time} · {outlet.address}</Text></View><Status status={outlet.status} /></TouchableOpacity>)}</>;
}

function Visit({ outlet, outcome, setOutcome, onStart, onOrder, onFinish }: { outlet: Outlet; outcome: string; setOutcome: (value: string) => void; onStart: () => void; onOrder: () => void; onFinish: () => void }) {
  const outcomes = ["Order placed", "No order", "Shop closed", "Owner unavailable"];
  return <><Text style={styles.screenTitle}>{outlet.name}</Text><Text style={styles.lede}>{outlet.address} · planned {outlet.time}</Text><View style={styles.card}><Text style={styles.eyebrow}>VISIT STATUS</Text><Text style={styles.cardTitle}>{outlet.status === "active" ? "Visit in progress" : outlet.status === "completed" ? "Visit completed" : "Ready to check in"}</Text>{outlet.status === "planned" && <Button label="GPS check in" onPress={onStart} />}</View>{outlet.status === "active" && <><Text style={styles.sectionTitle}>Visit outcome</Text><View style={styles.choiceWrap}>{outcomes.map((item) => <TouchableOpacity key={item} style={[styles.choice, outcome === item && styles.choiceSelected]} onPress={() => setOutcome(item)}><Text style={[styles.choiceText, outcome === item && styles.choiceTextSelected]}>{item}</Text></TouchableOpacity>)}</View><View style={styles.actionRow}><Button label="Create order" onPress={onOrder} /><GhostButton dark label="Finish visit" onPress={onFinish} /></View></>}</>;
}

function Order({ outlet, quantity, setQuantity, onSubmit }: { outlet: Outlet; quantity: string; setQuantity: (value: string) => void; onSubmit: () => void }) {
  const total = Math.max(0, Number(quantity) || 0) * 450;
  return <><Text style={styles.screenTitle}>Fast order</Text><Text style={styles.lede}>{outlet.name}</Text><View style={styles.card}><Text style={styles.inputLabel}>PRODUCT</Text><Text style={styles.cardTitle}>Yousuf Super Kernel Basmati</Text><Text style={styles.rowMeta}>Trade price · PKR 450/kg</Text><Text style={styles.inputLabel}>QUANTITY (KG)</Text><TextInput style={styles.input} value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" /><View style={styles.totalRow}><Text style={styles.totalLabel}>Order total</Text><Text style={styles.total}>PKR {total.toLocaleString()}</Text></View><Button label="Save order draft" onPress={onSubmit} /></View></>;
}

function SyncQueue({ queue, onSync }: { queue: QueueItem[]; onSync: () => void }) {
  const pending = queue.filter((item) => item.state === "pending").length;
  return <><Text style={styles.screenTitle}>Sync queue</Text><Text style={styles.lede}>“Confirmed” appears only after acknowledgement. Pilot mode keeps this state on the phone.</Text>{pending > 0 && <Button label={`Confirm ${pending} pilot records`} onPress={onSync} />}{queue.length === 0 ? <View style={styles.empty}><Text style={styles.cardTitle}>Nothing waiting</Text><Text style={styles.noticeBody}>New attendance, visits, and orders will appear here.</Text></View> : queue.map((item) => <View key={item.id} style={styles.listRow}><View style={[styles.dot, item.state === "confirmed" && styles.dotConfirmed]} /><View style={styles.grow}><Text style={styles.rowTitle}>{item.label}</Text><Text style={styles.rowMeta}>{item.state === "pending" ? "Stored safely on device" : "Confirmed"}</Text></View></View>)}</>;
}

function Profile({ shiftActive, pending }: { shiftActive: boolean; pending: number }) {
  return <><Text style={styles.screenTitle}>Field profile</Text><View style={styles.card}><Text style={styles.eyebrow}>SALES REPRESENTATIVE</Text><Text style={styles.cardTitle}>Ali Raza</Text><Text style={styles.lede}>Employee code SR-014 · Clifton Territory</Text></View><View style={styles.card}><Text style={styles.cardTitle}>Tracking & privacy</Text><Text style={styles.noticeBody}>Location is requested for shift and outlet evidence. Continuous background tracking is not enabled in this pilot.</Text><Text style={styles.profileLine}>Shift tracking: {shiftActive ? "Active" : "Stopped"}</Text><Text style={styles.profileLine}>Records pending: {pending}</Text></View></>;
}

function Nav({ screen, setScreen }: { screen: Screen; setScreen: (screen: Screen) => void }) {
  const items: { key: Screen; label: string }[] = [{ key: "today", label: "Today" }, { key: "route", label: "Route" }, { key: "sync", label: "Sync" }, { key: "profile", label: "Profile" }];
  return <View style={styles.nav}>{items.map((item) => <TouchableOpacity key={item.key} style={styles.navItem} onPress={() => setScreen(item.key)}><Text style={[styles.navText, screen === item.key && styles.navActive]}>{item.label}</Text></TouchableOpacity>)}</View>;
}

function Button({ label, onPress }: { label: string; onPress: () => void }) { return <TouchableOpacity style={styles.button} onPress={onPress}><Text style={styles.buttonText}>{label}</Text></TouchableOpacity>; }
function GhostButton({ label, onPress, dark = false }: { label: string; onPress: () => void; dark?: boolean }) { return <TouchableOpacity style={[styles.ghost, dark && styles.ghostDark]} onPress={onPress}><Text style={[styles.ghostText, dark && styles.ghostTextDark]}>{label}</Text></TouchableOpacity>; }
function Stat({ value, label }: { value: string; label: string }) { return <View><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>; }
function Status({ status }: { status: VisitStatus }) { return <Text style={[styles.status, status === "completed" && styles.statusDone, status === "active" && styles.statusActive]}>{status}</Text>; }

const navy = "#17233B", blue = "#243D74", gold = "#D8A629", paper = "#F7F8F4", line = "#DCE0D8", muted = "#697184";
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: paper }, app: { flex: 1 }, page: { padding: 20, paddingBottom: 110, gap: 18 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }, eyebrow: { fontSize: 10, fontWeight: "900", letterSpacing: 1.1, color: muted }, title: { fontSize: 26, fontWeight: "800", color: navy, marginTop: 4, maxWidth: 250 }, syncPill: { backgroundColor: "#FFF1D0", paddingHorizontal: 10, paddingVertical: 7, borderRadius: 99 }, syncText: { color: "#805C00", fontSize: 11, fontWeight: "900" },
  shiftCard: { backgroundColor: navy, borderRadius: 16, padding: 18, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }, darkLabel: { color: "#AAB3C5", fontSize: 10, fontWeight: "900" }, shiftValue: { color: "white", fontSize: 16, fontWeight: "800", marginTop: 4 }, button: { backgroundColor: gold, paddingHorizontal: 17, paddingVertical: 13, borderRadius: 9, alignItems: "center" }, buttonText: { fontWeight: "900", color: navy },
  sectionTitle: { fontSize: 19, fontWeight: "900", color: navy, marginTop: 5 }, stats: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderBottomWidth: 1, borderColor: line, paddingVertical: 16 }, statValue: { fontSize: 19, fontWeight: "900", color: navy }, statLabel: { fontSize: 11, color: muted, marginTop: 3 },
  hero: { backgroundColor: blue, borderRadius: 16, padding: 20 }, heroKicker: { fontSize: 10, fontWeight: "900", letterSpacing: 1, color: "#B6C2DF" }, heroTitle: { fontSize: 25, fontWeight: "900", color: "white", marginTop: 10 }, heroBody: { color: "#C2CBE0", marginTop: 6 }, actionRow: { flexDirection: "row", gap: 10, marginTop: 20, flexWrap: "wrap" }, ghost: { borderWidth: 1, borderColor: "#7081A8", paddingHorizontal: 17, paddingVertical: 12, borderRadius: 9 }, ghostDark: { borderColor: navy }, ghostText: { color: "white", fontWeight: "900" }, ghostTextDark: { color: navy },
  notice: { backgroundColor: "#E9EEE8", borderLeftWidth: 4, borderLeftColor: "#267057", padding: 16, borderRadius: 8 }, noticeTitle: { fontWeight: "900", color: navy }, noticeBody: { color: "#586273", lineHeight: 20, marginTop: 5 },
  screenTitle: { fontSize: 32, fontWeight: "900", color: navy }, lede: { color: muted, lineHeight: 20 }, listRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 15, borderBottomWidth: 1, borderColor: line }, index: { width: 30, color: "#9A7A23", fontWeight: "900" }, grow: { flex: 1 }, rowTitle: { color: navy, fontWeight: "800" }, rowMeta: { color: muted, fontSize: 12, marginTop: 4 }, status: { fontSize: 10, fontWeight: "900", color: muted, textTransform: "uppercase" }, statusDone: { color: "#267057" }, statusActive: { color: "#9A6300" },
  card: { backgroundColor: "white", borderWidth: 1, borderColor: line, borderRadius: 14, padding: 18, gap: 13 }, cardTitle: { fontSize: 21, fontWeight: "900", color: navy }, choiceWrap: { flexDirection: "row", flexWrap: "wrap", gap: 9 }, choice: { borderWidth: 1, borderColor: line, borderRadius: 99, paddingHorizontal: 14, paddingVertical: 10 }, choiceSelected: { backgroundColor: navy, borderColor: navy }, choiceText: { color: navy, fontWeight: "700" }, choiceTextSelected: { color: "white" }, inputLabel: { fontSize: 10, fontWeight: "900", color: muted, letterSpacing: 1, marginTop: 7 }, input: { borderWidth: 1, borderColor: line, borderRadius: 9, padding: 13, fontSize: 18, color: navy }, totalRow: { borderTopWidth: 1, borderColor: line, paddingTop: 14, flexDirection: "row", justifyContent: "space-between" }, totalLabel: { color: muted, fontWeight: "700" }, total: { color: navy, fontSize: 18, fontWeight: "900" },
  empty: { padding: 30, backgroundColor: "#E9EEE8", borderRadius: 12, alignItems: "center" }, dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#D89B29" }, dotConfirmed: { backgroundColor: "#267057" }, profileLine: { color: navy, fontWeight: "700", borderTopWidth: 1, borderColor: line, paddingTop: 12 },
  nav: { position: "absolute", left: 14, right: 14, bottom: 12, backgroundColor: navy, borderRadius: 16, flexDirection: "row", padding: 7 }, navItem: { flex: 1, alignItems: "center", paddingVertical: 11 }, navText: { color: "#9FAABD", fontSize: 12, fontWeight: "800" }, navActive: { color: gold },
});
