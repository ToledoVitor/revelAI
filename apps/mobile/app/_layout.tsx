import { Arimo_400Regular, Arimo_700Bold } from "@expo-google-fonts/arimo";
import { BebasNeue_400Regular } from "@expo-google-fonts/bebas-neue";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { resolveContractsOnce } from "../src/runtime/contracts-resolution";

resolveContractsOnce();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Arimo: Arimo_400Regular,
    "Arimo Bold": Arimo_700Bold,
    "Bebas Neue": BebasNeue_400Regular,
  });

  if (!fontsLoaded && Platform.OS !== "web") return null;

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <Stack screenOptions={{ headerShown: false }} />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
