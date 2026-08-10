export type LiveEmployee = {
  id: string;
  name: string;
};

export type LiveLocationPoint = {
  id: string;
  employeeId: string;
  capturedAt: string;
  receivedAt: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  source: string;
};

export type LiveAttendance = {
  id: string;
  employeeId: string;
  status: string;
  checkInAt: string;
  checkOutAt: string | null;
};

export type LiveOperationsPayload = {
  serverTime: string;
  employees: LiveEmployee[];
  attendance: LiveAttendance[];
  points: LiveLocationPoint[];
};
