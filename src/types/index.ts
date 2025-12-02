import { Request } from 'express';

export interface JwtPayload {
  userId: number;
  email: string;
  rol: string;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface UserResponse {
  id: number;
  nombre: string;
  email: string;
  rol: string;
  area: string;
  puesto: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: UserResponse;
}
