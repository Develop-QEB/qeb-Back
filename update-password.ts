import bcrypt from 'bcryptjs';
import prisma from './src/utils/prisma';

async function main() {
  const user = await prisma.usuario.findFirst({
    where: { correo_electronico: 'mario.salcido@deepia.dev' }
  });

  if (user) {
    console.log('Usuario encontrado:', user.nombre);
    console.log('Password actual:', user.user_password ? user.user_password.substring(0, 40) + '...' : 'NULL');

    const newHash = await bcrypt.hash('Holahola123', 10);
    console.log('Nuevo hash bcrypt:', newHash);

    await prisma.usuario.update({
      where: { id: user.id },
      data: { user_password: newHash }
    });
    console.log('Contrasena actualizada correctamente!');
  } else {
    console.log('Usuario no encontrado');
  }

  await prisma.$disconnect();
}

main().catch(console.error);
