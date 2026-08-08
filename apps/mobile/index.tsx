import AsyncStorage from "@react-native-async-storage/async-storage";
import { registerRootComponent } from "expo";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import FieldOpsApp, { STORAGE_KEY } from "./app/index";

type StartupBoundaryState = { error: Error | null; resetKey: number };

class StartupBoundary extends Component<{ children: ReactNode }, StartupBoundaryState> {
  state: StartupBoundaryState = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): StartupBoundaryState {
    return { error, resetKey: 0 };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("FieldOPS startup failed", error, info.componentStack);
  }

  private resetPilot = async () => {
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
    this.setState((state) => ({ error: null, resetKey: state.resetKey + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <View style={startupStyles.page}>
          <Text style={startupStyles.eyebrow}>YOUSUF RICE · FIELDOPS</Text>
          <Text style={startupStyles.title}>FieldOPS needs a quick reset</Text>
          <Text style={startupStyles.body}>
            The saved pilot data on this phone could not be opened. Reset it to continue.
          </Text>
          <TouchableOpacity style={startupStyles.button} onPress={this.resetPilot}>
            <Text style={startupStyles.buttonText}>Reset and open FieldOPS</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return <View key={this.state.resetKey} style={startupStyles.app}>{this.props.children}</View>;
  }
}

function Root() {
  return (
    <StartupBoundary>
      <FieldOpsApp />
    </StartupBoundary>
  );
}

const startupStyles = StyleSheet.create({
  app: { flex: 1 },
  page: {
    flex: 1,
    justifyContent: "center",
    padding: 28,
    backgroundColor: "#F7F8F4",
  },
  eyebrow: { color: "#697184", fontSize: 11, fontWeight: "900", letterSpacing: 1.1 },
  title: { color: "#17233B", fontSize: 30, fontWeight: "900", marginTop: 10 },
  body: { color: "#586273", fontSize: 16, lineHeight: 24, marginTop: 12 },
  button: { alignItems: "center", backgroundColor: "#D8A629", borderRadius: 10, marginTop: 24, padding: 15 },
  buttonText: { color: "#17233B", fontWeight: "900" },
});

registerRootComponent(Root);
