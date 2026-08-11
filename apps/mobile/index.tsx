import AsyncStorage from "@react-native-async-storage/async-storage";
import { registerRootComponent } from "expo";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Text, TouchableOpacity, View } from "react-native";

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
        <View className="flex-1 justify-center bg-paper px-7">
          <Text className="text-[11px] font-black tracking-[1.1px] text-muted">YOUSUF RICE · FIELDOPS</Text>
          <Text className="mt-2.5 text-3xl font-black text-ink">FieldOPS needs a quick reset</Text>
          <Text className="mt-3 text-base leading-6 text-[#586273]">
            The saved pilot data on this phone could not be opened. Reset it to continue.
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Reset saved FieldOPS data and reopen the app"
            className="mt-6 min-h-12 items-center justify-center rounded-[10px] bg-gold px-4"
            onPress={this.resetPilot}
          >
            <Text className="font-black text-ink">Reset and open FieldOPS</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return <View key={this.state.resetKey} className="flex-1">{this.props.children}</View>;
  }
}

function Root() {
  return (
    <StartupBoundary>
      <FieldOpsApp />
    </StartupBoundary>
  );
}

registerRootComponent(Root);
