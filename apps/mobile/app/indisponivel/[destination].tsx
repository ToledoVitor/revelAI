import { useLocalSearchParams } from "expo-router";
import { UnavailableScreen } from "../../src/navigation/UnavailableScreen";

export default function UnavailableRoute() {
  const { destination } = useLocalSearchParams<{
    destination?: string | string[];
  }>();
  const normalizedDestination = Array.isArray(destination)
    ? (destination[0] ?? "")
    : (destination ?? "");

  return <UnavailableScreen destination={normalizedDestination} />;
}
